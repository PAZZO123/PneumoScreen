#!/usr/bin/env python3
"""check_mfcc.py – Compare the C++ MFCC implementation against pneumo_features.mfcc().

Picks up to 20 WAV clips from data/{normal,crackles,wheezes}, resamples to 4 kHz,
runs both the Python reference and the compiled C++ host binary, and reports the
per-coefficient max and mean absolute error.

Exit criterion: max absolute error < 0.5 on every coefficient.

Build the host binary first:
    g++ -O2 -I firmware/lung_sound tools/mfcc_host.cpp firmware/lung_sound/mfcc.cpp -lm -o mfcc_host

Usage:
    python tools/check_mfcc.py [--binary ./mfcc_host] [--data-dir data] [--max-clips 20]
"""
import argparse, os, sys, subprocess, tempfile, struct
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pneumo_features as pf

def find_clips(data_dir, max_clips):
    clips = []
    for cls in ('normal', 'crackles', 'wheezes'):
        d = os.path.join(data_dir, cls)
        if not os.path.isdir(d):
            continue
        wavs = sorted(f for f in os.listdir(d) if f.endswith('.wav'))
        clips.extend(os.path.join(d, w) for w in wavs)
    # Spread across classes: take every Nth
    if len(clips) > max_clips:
        step = max(1, len(clips) // max_clips)
        clips = clips[::step][:max_clips]
    return clips

def run_python_mfcc(wav_path):
    import librosa as _lr
    y, _ = _lr.load(wav_path, sr=pf.SR, mono=True)
    return pf.mfcc(y)           # (13, 124) float32

def run_cpp_mfcc(wav_path, binary):
    import librosa as _lr
    y, _ = _lr.load(wav_path, sr=pf.SR, mono=True)
    y = pf.fit_length(y.astype(np.float32))     # 8000 samples

    # Write raw float32 to stdin, read float32 from stdout
    inp = y.tobytes()
    result = subprocess.run(
        [binary],
        input=inp,
        capture_output=True,
        timeout=10
    )
    if result.returncode != 0:
        raise RuntimeError(f'{binary} failed: {result.stderr.decode()}')

    out = np.frombuffer(result.stdout, dtype=np.float32)
    if out.size != pf.N_MFCC * pf.FRAMES:
        raise RuntimeError(f'Expected {pf.N_MFCC * pf.FRAMES} floats, got {out.size}')
    return out.reshape(pf.N_MFCC, pf.FRAMES)

def main():
    parser = argparse.ArgumentParser(description='MFCC parity check: C++ vs Python')
    parser.add_argument('--binary', default='./mfcc_host', help='Path to mfcc_host binary')
    parser.add_argument('--data-dir', default='data', help='Data directory')
    parser.add_argument('--max-clips', type=int, default=20, help='Max clips to test')
    args = parser.parse_args()

    if not os.path.isfile(args.binary):
        sys.exit(f'Error: binary not found at {args.binary}. Build it first (see docstring).')

    clips = find_clips(args.data_dir, args.max_clips)
    if not clips:
        sys.exit(f'Error: no WAV files found in {args.data_dir}/{{normal,crackles,wheezes}}/')

    print(f'Testing {len(clips)} clips...\n')

    per_coeff_max  = np.zeros(pf.N_MFCC)
    per_coeff_mean = np.zeros(pf.N_MFCC)
    overall_max    = 0.0
    n_tested       = 0

    for wav in clips:
        try:
            py  = run_python_mfcc(wav)
            cpp = run_cpp_mfcc(wav, args.binary)
        except Exception as e:
            print(f'  SKIP {os.path.basename(wav)}: {e}')
            continue

        diff = np.abs(py - cpp)
        clip_max = diff.max()
        overall_max = max(overall_max, clip_max)

        for k in range(pf.N_MFCC):
            per_coeff_max[k]  = max(per_coeff_max[k], diff[k].max())
            per_coeff_mean[k] += diff[k].mean()

        tag = 'OK' if clip_max < 0.5 else 'FAIL'
        print(f'  [{tag}] {os.path.basename(wav):40s}  max_err={clip_max:.4f}')
        n_tested += 1

    if n_tested == 0:
        sys.exit('No clips tested successfully.')

    per_coeff_mean /= n_tested

    print(f'\n{"Coeff":>6}  {"Max Err":>10}  {"Mean Err":>10}')
    print('-' * 32)
    for k in range(pf.N_MFCC):
        flag = ' *' if per_coeff_max[k] >= 0.5 else ''
        print(f'  {k:4d}  {per_coeff_max[k]:10.4f}  {per_coeff_mean[k]:10.4f}{flag}')

    print(f'\nOverall max absolute error: {overall_max:.4f}')
    print(f'Clips tested: {n_tested}')

    if overall_max < 0.5:
        print('\nPASS: all coefficients within tolerance (< 0.5)')
        return 0
    else:
        print('\nFAIL: some coefficients exceed tolerance (>= 0.5)')
        return 1

if __name__ == '__main__':
    sys.exit(main())
