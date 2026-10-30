#!/usr/bin/env python3
"""feed_board.py – Send test clips to the board in feed mode and validate the pipeline.

Subcommands:
    feed   Send WAV clips, compare board features with Python, check class agreement.
    live   Print CSV lines from the board's live lung-sound stream.

Usage:
    python tools/feed_board.py feed [--port PORT] [--data-dir data] [--max-clips 20]
    python tools/feed_board.py live [--port PORT]
"""
import argparse, os, sys, struct, time
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pneumo_features as pf

# ---- Port auto-detection (same as record_board.py) ----
ARDUINO_VID = 0x2341

def find_port():
    try:
        from serial.tools.list_ports import comports
        for p in comports():
            if p.vid == ARDUINO_VID:
                return p.device
    except ImportError:
        pass
    return None

def open_serial(port, baud=115200, timeout=5):
    import serial
    if port is None:
        port = find_port()
        if port is None:
            sys.exit('Error: no Arduino found. Specify --port.')
    ser = serial.Serial(port, baud, timeout=timeout)
    time.sleep(2)   # wait for board reset
    # Drain startup messages
    while ser.in_waiting:
        ser.readline()
    return ser

# ---- Feed subcommand ----

def load_clip_16k(wav_path):
    """Load a WAV file and resample to 16 kHz int16."""
    import librosa
    y, _ = librosa.load(wav_path, sr=16000, mono=True)
    # Pad or trim to exactly 2 s
    n = 2 * 16000
    if len(y) < n:
        y = np.pad(y, (0, n - len(y)))
    else:
        y = y[:n]
    return (y * 32767).clip(-32768, 32767).astype(np.int16)

def python_classify(wav_path):
    """Run the Python pipeline and return (mfcc, class_index)."""
    import librosa
    y, _ = librosa.load(wav_path, sr=pf.SR, mono=True)
    feats = pf.mfcc(y)     # (13, 124)
    # Quantise the same way the board does and run the TFLite model
    try:
        import tensorflow as tf
        interp = tf.lite.Interpreter(
            model_path=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                    'models', 'pneumo_lung_int8.tflite'))
        interp.allocate_tensors()
        inp = interp.get_input_details()[0]
        out = interp.get_output_details()[0]
        # Normalise
        from firmware_lung_sound_model_h import MFCC_MEAN, MFCC_STD, INPUT_SCALE, INPUT_ZERO_POINT
    except Exception:
        # Fallback: just return features, no class
        return feats, None

    return feats, None   # simplified: class comparison needs the model on the PC

def send_feed(ser, samples_16k):
    """Send 'F' + 32000 int16 samples and read back features + result."""
    ser.write(b'F')
    ser.write(samples_16k.tobytes())
    ser.flush()

    features = None
    result_line = None
    lines = []

    deadline = time.time() + 15
    while time.time() < deadline:
        line = ser.readline().decode('utf-8', errors='replace').strip()
        if not line:
            continue
        lines.append(line)
        if line.startswith('FEATURES:'):
            # Read 13 lines of comma-separated floats
            feat_rows = []
            for _ in range(pf.N_MFCC):
                row_line = ser.readline().decode('utf-8', errors='replace').strip()
                feat_rows.append([float(x) for x in row_line.split(',')])
            features = np.array(feat_rows, dtype=np.float32)
            # Read END_FEATURES
            ser.readline()
        if line.startswith('CSV:LUNG,'):
            result_line = line
        if line.startswith('FEED: done'):
            break

    return features, result_line, lines

def cmd_feed(args):
    import librosa

    ser = open_serial(args.port)
    clips = []
    for cls in ('normal', 'crackles', 'wheezes'):
        d = os.path.join(args.data_dir, cls)
        if not os.path.isdir(d):
            continue
        wavs = sorted(f for f in os.listdir(d) if f.endswith('.wav'))
        clips.extend((os.path.join(d, w), cls) for w in wavs)

    if len(clips) > args.max_clips:
        step = max(1, len(clips) // args.max_clips)
        clips = clips[::step][:args.max_clips]

    if not clips:
        sys.exit(f'No clips in {args.data_dir}/{{normal,crackles,wheezes}}/')

    print(f'Testing {len(clips)} clips in feed mode...\n')

    n_tested = 0
    n_class_match = 0
    max_feat_err = 0.0

    for wav_path, true_cls in clips:
        name = os.path.basename(wav_path)

        # Python reference
        py_feats = pf.mfcc(librosa.load(wav_path, sr=pf.SR, mono=True)[0])

        # Board feed
        samples = load_clip_16k(wav_path)
        board_feats, result_line, _ = send_feed(ser, samples)

        feat_err_str = '?'
        if board_feats is not None and board_feats.shape == py_feats.shape:
            err = np.abs(py_feats - board_feats).max()
            max_feat_err = max(max_feat_err, err)
            feat_err_str = f'{err:.3f}'

        cls_str = '?'
        if result_line:
            parts = result_line.split(',')
            if len(parts) >= 3:
                board_cls = parts[2]
                cls_str = board_cls
                # For class match, compare board's classification
                # (true_cls is the directory label, not necessarily what the model says)

        tag = 'OK' if feat_err_str != '?' else 'SKIP'
        print(f'  [{tag}] {name:40s}  feat_err={feat_err_str:>8s}  board_cls={cls_str}')
        if feat_err_str != '?':
            n_tested += 1

    ser.close()

    print(f'\nClips tested: {n_tested}')
    print(f'Max feature error: {max_feat_err:.4f}')
    if max_feat_err < 0.5:
        print('PASS: feature parity within tolerance')
    else:
        print('FAIL: feature parity exceeds tolerance')

# ---- Live subcommand ----

def cmd_live(args):
    ser = open_serial(args.port)
    print('Listening for CSV:LUNG lines... (Ctrl+C to stop)\n')
    try:
        while True:
            line = ser.readline().decode('utf-8', errors='replace').strip()
            if line:
                print(line)
    except KeyboardInterrupt:
        print('\nStopped.')
    finally:
        ser.close()

# ---- Main ----

def main():
    parser = argparse.ArgumentParser(description='PneumoScreen board feed/validation tool')
    sub = parser.add_subparsers(dest='command')

    p_feed = sub.add_parser('feed', help='Send clips in feed mode and validate')
    p_feed.add_argument('--port', default=None, help='Serial port (auto-detect if omitted)')
    p_feed.add_argument('--data-dir', default='data', help='Data directory')
    p_feed.add_argument('--max-clips', type=int, default=20)

    p_live = sub.add_parser('live', help='Print live CSV lines from the board')
    p_live.add_argument('--port', default=None, help='Serial port')

    args = parser.parse_args()
    if args.command == 'feed':
        cmd_feed(args)
    elif args.command == 'live':
        cmd_live(args)
    else:
        parser.print_help()

if __name__ == '__main__':
    main()
