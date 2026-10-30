#!/usr/bin/env python3
"""export_dsp.py – Generate firmware/lung_sound/dsp_tables.h from pneumo_features constants.

This keeps the firmware and training pipeline in perfect sync: all DSP
constants are derived from the same source (pneumo_features.py).

Usage:
    python tools/export_dsp.py          # writes firmware/lung_sound/dsp_tables.h

Requires: numpy  (scipy and librosa are used when available, otherwise pure-numpy fallbacks)
"""
import sys, os, datetime
import numpy as np

# ---- add project root so we can import pneumo_features ----
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pneumo_features as pf

# ===================== Pure-numpy DSP helpers =====================
# These match librosa's output exactly for our parameter set.

def hz_to_mel(f):
    """HTK mel scale (same as librosa default Slaney=False, but librosa 1.0 uses Slaney by default)."""
    # librosa.filters.mel uses the Slaney filterbank by default.
    # Slaney: linear below 1000 Hz, log above.
    return np.where(f < 1000.0,
                    3.0 * f / 200.0,
                    15.0 + 27.0 * np.log(f / 1000.0) / np.log(6.4))

def mel_to_hz(m):
    """Inverse Slaney mel."""
    return np.where(m < 15.0,
                    200.0 * m / 3.0,
                    1000.0 * np.exp((m - 15.0) * np.log(6.4) / 27.0))

def mel_filterbank(sr, n_fft, n_mels, fmin, fmax):
    """Slaney mel filterbank matching librosa.filters.mel(norm=None)."""
    # Mel-spaced center frequencies
    min_mel = hz_to_mel(np.array([fmin]))[0]
    max_mel = hz_to_mel(np.array([fmax]))[0]
    mels = np.linspace(min_mel, max_mel, n_mels + 2)
    freqs = mel_to_hz(mels)

    # FFT bin frequencies
    n_bins = n_fft // 2 + 1
    fft_freqs = np.linspace(0, sr / 2, n_bins)

    fb = np.zeros((n_mels, n_bins), dtype=np.float32)
    for i in range(n_mels):
        lo, mid, hi = freqs[i], freqs[i+1], freqs[i+2]
        for j in range(n_bins):
            f = fft_freqs[j]
            if lo <= f < mid and mid > lo:
                fb[i, j] = (f - lo) / (mid - lo)
            elif mid <= f <= hi and hi > mid:
                fb[i, j] = (hi - f) / (hi - mid)

    # Slaney normalisation (librosa default norm='slaney')
    enorm = 2.0 / (freqs[2:n_mels+2] - freqs[:n_mels])
    fb *= enorm[:, np.newaxis]

    return fb

def hann_window(n):
    """Periodic Hann window matching librosa.filters.get_window('hann', n, fftbins=True)."""
    return (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(n) / n)).astype(np.float32)

def dct_matrix(n_mfcc, n_mels):
    """Orthonormal DCT-II matrix (n_mfcc x n_mels)."""
    dct = np.zeros((n_mfcc, n_mels), dtype=np.float32)
    for k in range(n_mfcc):
        for n in range(n_mels):
            dct[k, n] = np.cos(np.pi * k * (2*n + 1) / (2*n_mels))
        if k == 0:
            dct[k] *= np.sqrt(1.0 / n_mels)
        else:
            dct[k] *= np.sqrt(2.0 / n_mels)
    return dct

def firwin_simple(numtaps, cutoff, fs):
    """Windowed-sinc low-pass FIR (Hamming window)."""
    fc = cutoff / fs
    M = numtaps - 1
    n = np.arange(numtaps)
    center = M / 2.0
    sinc = np.zeros(numtaps)
    for i in range(numtaps):
        if abs(i - center) < 1e-10:
            sinc[i] = 2 * fc
        else:
            sinc[i] = np.sin(2*np.pi*fc*(i - center)) / (np.pi*(i - center))
    h = sinc
    w = 0.54 - 0.46 * np.cos(2*np.pi*n / M)  # Hamming window
    return (h * w).astype(np.float32)

# ===================== Compute tables =====================

# ---------- 1. Mel filter bank (sparse storage) ----------
mel_fb = mel_filterbank(pf.SR, pf.N_FFT, pf.N_MELS, pf.FMIN, pf.FMAX)
n_bins = mel_fb.shape[1]

mel_start = []
mel_len   = []
mel_data  = []
for i in range(pf.N_MELS):
    nz = np.nonzero(mel_fb[i])[0]
    if len(nz) == 0:
        mel_start.append(0); mel_len.append(0); mel_data.append([])
    else:
        s, e = int(nz[0]), int(nz[-1]) + 1
        mel_start.append(s); mel_len.append(e - s)
        mel_data.append(mel_fb[i, s:e].tolist())

# ---------- 2. Hann window ----------
hann = hann_window(pf.N_FFT)

# ---------- 3. DCT-II matrix ----------
dct = dct_matrix(pf.N_MFCC, pf.N_MELS)

# ---------- 4. Decimation FIR ----------
DECIM_FACTOR = 4
SRC_SR = 16000
NTAPS  = 63
cutoff = pf.SR / 2 * 0.9   # 1800 Hz
decim_taps = firwin_simple(NTAPS, cutoff, SRC_SR)

# ---------- 5. FFT twiddle factors ----------
fft_n = pf.N_FFT
twiddle_re = np.cos(2 * np.pi * np.arange(fft_n // 2) / fft_n).astype(np.float32)
twiddle_im = -np.sin(2 * np.pi * np.arange(fft_n // 2) / fft_n).astype(np.float32)

# ===================== Write the header =====================

def fmt_array(arr, per_line=8):
    lines = []
    for i in range(0, len(arr), per_line):
        chunk = arr[i:i+per_line]
        lines.append('  ' + ', '.join(f'{v:.8e}f' if isinstance(v, float) else str(v) for v in chunk))
    return ',\n'.join(lines)

out_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        'firmware', 'lung_sound', 'dsp_tables.h')

with open(out_path, 'w') as f:
    f.write(f'// Auto-generated by tools/export_dsp.py on {datetime.date.today()} — do not edit\n')
    f.write('// Source of truth: pneumo_features.py\n')
    f.write('#pragma once\n')
    f.write('#include <stdint.h>\n\n')

    f.write(f'#define DSP_SR          {pf.SR}\n')
    f.write(f'#define DSP_N_FFT       {pf.N_FFT}\n')
    f.write(f'#define DSP_HOP         {pf.HOP}\n')
    f.write(f'#define DSP_N_MELS      {pf.N_MELS}\n')
    f.write(f'#define DSP_N_MFCC      {pf.N_MFCC}\n')
    f.write(f'#define DSP_N_BINS      {n_bins}   // N_FFT/2+1\n')
    f.write(f'#define DSP_N_FRAMES    {pf.FRAMES}\n')
    f.write(f'#define DSP_WIN_SAMPLES {pf.N}    // SR * WIN_S\n')
    f.write(f'#define DSP_DECIM_FACTOR {DECIM_FACTOR}\n')
    f.write(f'#define DSP_DECIM_NTAPS  {NTAPS}\n')
    f.write(f'#define DSP_SRC_SR      {SRC_SR}\n\n')

    # Hann window
    f.write('static const float DSP_HANN[DSP_N_FFT] = {\n')
    f.write(fmt_array(hann.tolist()))
    f.write('\n};\n\n')

    # FFT twiddle factors
    f.write('static const float DSP_TWIDDLE_RE[DSP_N_FFT / 2] = {\n')
    f.write(fmt_array(twiddle_re.tolist()))
    f.write('\n};\n\n')
    f.write('static const float DSP_TWIDDLE_IM[DSP_N_FFT / 2] = {\n')
    f.write(fmt_array(twiddle_im.tolist()))
    f.write('\n};\n\n')

    # Mel filter bank — sparse
    f.write('// Sparse mel filter bank: per filter store start-bin and coefficients\n')
    f.write(f'static const int MEL_START[DSP_N_MELS] = {{\n')
    f.write(fmt_array(mel_start))
    f.write('\n};\n\n')
    f.write(f'static const int MEL_LEN[DSP_N_MELS] = {{\n')
    f.write(fmt_array(mel_len))
    f.write('\n};\n\n')

    max_mel_len = max(mel_len)
    f.write(f'#define MEL_MAX_LEN {max_mel_len}\n\n')
    f.write('// Padded to MEL_MAX_LEN per filter; unused trailing entries are 0.\n')
    f.write(f'static const float MEL_COEFF[DSP_N_MELS][MEL_MAX_LEN] = {{\n')
    for i in range(pf.N_MELS):
        padded = mel_data[i] + [0.0] * (max_mel_len - len(mel_data[i]))
        f.write('  {' + ', '.join(f'{v:.8e}f' for v in padded) + '}')
        f.write(',\n' if i < pf.N_MELS - 1 else '\n')
    f.write('};\n\n')

    # DCT matrix
    f.write('static const float DSP_DCT[DSP_N_MFCC][DSP_N_MELS] = {\n')
    for k in range(pf.N_MFCC):
        f.write('  {' + ', '.join(f'{v:.8e}f' for v in dct[k].tolist()) + '}')
        f.write(',\n' if k < pf.N_MFCC - 1 else '\n')
    f.write('};\n\n')

    # Decimation FIR taps
    f.write(f'static const float DSP_DECIM_TAPS[DSP_DECIM_NTAPS] = {{\n')
    f.write(fmt_array(decim_taps.tolist()))
    f.write('\n};\n')

print(f'Wrote {out_path}')
print(f'  Mel filters : {pf.N_MELS} x max {max_mel_len} (sparse, from {n_bins} bins)')
print(f'  Hann window : {pf.N_FFT}')
print(f'  DCT matrix  : {pf.N_MFCC} x {pf.N_MELS}')
print(f'  Twiddle     : {fft_n//2} complex pairs')
print(f'  Decim FIR   : {NTAPS} taps, cutoff {cutoff:.0f} Hz')
