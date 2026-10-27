# record_board.py
# Capture audio from the Nano 33 BLE Sense microphone (firmware/record_audio) and save labelled WAVs.
#
#   Own recordings (noise, talking, your breathing...):
#     python tools/record_board.py record --label noise_room --seconds 10 --takes 5
#   Re-record ICBHI clips through the board (play on PC speaker, record on board mic):
#     python tools/record_board.py replay --per-class 50
#   Quick microphone check:
#     python tools/record_board.py test
import argparse, csv, os, time, datetime
import numpy as np, pandas as pd, serial, soundfile as sf
from serial.tools import list_ports

SR = 16000
OUT_DIR = 'data/device'
MANIFEST = os.path.join(OUT_DIR, 'device_manifest.csv')


def find_port():
    for p in list_ports.comports():
        if p.vid == 0x2341:                       # Arduino USB vendor ID
            return p.device
    raise SystemExit('No Arduino found. Plug in the board, or pass --port COMx.')


class Board:
    def __init__(self, port, gain):
        self.ser = serial.Serial(port, 115200, timeout=2)
        time.sleep(1.5)
        self.ser.reset_input_buffer()
        self.ser.write(b'G' + bytes([gain]))

    def record(self, seconds, on_start=None):
        self.ser.reset_input_buffer()
        self.ser.write(b'R')
        sync = b''
        while not sync.endswith(b'PNEU'):
            b = self.ser.read(1)
            if not b:
                raise RuntimeError('Board did not start streaming - is record_audio.ino uploaded?')
            sync += b
        if on_start: on_start()
        want = int(seconds * SR) * 2
        data = bytearray()
        while len(data) < want:
            data += self.ser.read(min(4096, want - len(data)))
        self.ser.write(b'S')
        time.sleep(0.2)
        self.ser.reset_input_buffer()
        return np.frombuffer(bytes(data), dtype='<i2')

    def close(self):
        self.ser.close()


def save(audio, path, row):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sf.write(path, audio, SR, subtype='PCM_16')
    new = not os.path.exists(MANIFEST)
    with open(MANIFEST, 'a', newline='') as f:
        w = csv.writer(f)
        if new: w.writerow(['path', 'label', 'mode', 'source', 'patient_id', 'gain', 'seconds', 'peak'])
        w.writerow([path] + row + [round(len(audio) / SR, 3), int(np.abs(audio).max())])


def level_report(audio):
    peak = int(np.abs(audio).max()); rms = float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))
    note = 'CLIPPING - lower --gain' if peak >= 32000 else 'very quiet - raise --gain' if peak < 500 else 'ok'
    return f'peak {peak:5d}  rms {rms:7.1f}  ({note})'


def cmd_test(board, args):
    a = board.record(3)
    print('3 s test:', level_report(a))
    save(a, f'{OUT_DIR}/test/mic_test.wav', ['test', 'test', '', '', args.gain])
    print(f'Saved {OUT_DIR}/test/mic_test.wav - play it to check it sounds right.')


def cmd_record(board, args):
    for t in range(args.takes):
        input(f'[{t + 1}/{args.takes}] "{args.label}" - press Enter to record {args.seconds}s...')
        a = board.record(args.seconds)
        stamp = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
        path = f'{OUT_DIR}/own/{args.label}/{args.label}_{stamp}.wav'
        save(a, path, [args.label, 'own', args.note, args.subject, args.gain])
        print('   ', level_report(a), '->', path)


def cmd_replay(board, args):
    import sounddevice as sd
    m = pd.read_csv('data/clips_manifest.csv')
    done = set()
    if os.path.exists(MANIFEST):
        done = set(pd.read_csv(MANIFEST).query("mode == 'replay'")['source'])
    picks = (m[~m.path.isin(done)]
             .groupby('label', group_keys=False)
             .apply(lambda g: g.sample(min(args.per_class, len(g)), random_state=args.seed)))
    print(f'Replaying {len(picks)} clips. Keep the room quiet; speaker {args.distance} from the board.')
    for i, row in enumerate(picks.itertuples(), 1):
        clip, sr = sf.read(row.path, dtype='float32')
        clip = clip / max(1e-6, np.abs(clip).max()) * args.volume
        secs = len(clip) / sr + 0.4
        a = board.record(secs, on_start=lambda: (time.sleep(0.2), sd.play(clip, sr)))
        sd.wait()
        name = os.path.basename(row.path)
        path = f'{OUT_DIR}/replay/{row.label}/{name}'
        save(a, path, [row.label, 'replay', row.path, row.patient_id, args.gain])
        print(f'{i:4d}/{len(picks)} {row.label:9s} {level_report(a)}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--port'); ap.add_argument('--gain', type=int, default=20)
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('test')
    r = sub.add_parser('record')
    r.add_argument('--label', required=True); r.add_argument('--seconds', type=float, default=10)
    r.add_argument('--takes', type=int, default=1); r.add_argument('--subject', default='')
    r.add_argument('--note', default='')
    p = sub.add_parser('replay')
    p.add_argument('--per-class', type=int, default=50); p.add_argument('--seed', type=int, default=0)
    p.add_argument('--volume', type=float, default=0.8); p.add_argument('--distance', default='~10 cm')
    args = ap.parse_args()

    board = Board(args.port or find_port(), args.gain)
    try:
        {'test': cmd_test, 'record': cmd_record, 'replay': cmd_replay}[args.cmd](board, args)
    finally:
        board.close()
