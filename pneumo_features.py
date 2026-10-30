# pneumo_features.py
# Feature settings shared by dataset building, training and the firmware export.
# Lung sounds sit below 2 kHz and the datasets were recorded at 4-44.1 kHz, so everything is
# resampled to 4 kHz and the mel filters cover 50-2000 Hz only. That keeps every dataset (and the
# board's microphone) in the same band, so the model cannot tell datasets apart by bandwidth.
import numpy as np, librosa

SR       = 4000        # Hz
WIN_S    = 2.0         # seconds per window
N        = int(SR * WIN_S)
N_FFT    = 128         # 32 ms frames
HOP      = 64          # 16 ms hop
N_MELS   = 32
N_MFCC   = 13
FMIN, FMAX = 50, 2000
FRAMES   = 1 + (N - N_FFT) // HOP          # 124
CLASSES  = ['normal', 'crackles', 'wheezes', 'noise']


def fit_length(x):
    return np.pad(x, (0, max(0, N - len(x))))[:N]


def mfcc(x):
    """13 x 124 MFCCs of one window. Audio is RMS-normalised so loudness does not matter."""
    x = fit_length(np.asarray(x, dtype=np.float32))
    x = x - x.mean()
    x = x / (np.sqrt(np.mean(x ** 2)) + 1e-6)
    return librosa.feature.mfcc(y=x, sr=SR, n_mfcc=N_MFCC, n_fft=N_FFT, win_length=N_FFT,
                                hop_length=HOP, center=False, n_mels=N_MELS,
                                fmin=FMIN, fmax=FMAX).astype(np.float32)
