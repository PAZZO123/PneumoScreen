// mfcc.h – Portable MFCC feature extraction for PneumoScreen
// No Arduino dependencies: compiles on the board AND with g++ on the PC.
// Matches pneumo_features.mfcc() step-for-step:
//   subtract mean → divide by RMS → framed Hann window → 128-pt FFT
//   → power spectrum → mel filterbank → 10*log10 → clip top_db=80 → DCT-II
#pragma once

#include <stdint.h>

// ---------- constants from dsp_tables.h / model.h ----------
// These are defined in dsp_tables.h but we reference them by value here
// so the header stays self-contained for documentation purposes.
#ifndef DSP_SR
#define DSP_SR          4000
#define DSP_N_FFT       128
#define DSP_HOP         64
#define DSP_N_MELS      32
#define DSP_N_MFCC      13
#define DSP_N_BINS      65
#define DSP_N_FRAMES    124
#define DSP_WIN_SAMPLES 8000
#define DSP_DECIM_FACTOR 4
#define DSP_SRC_SR      16000
#endif

// ---------- Decimator: 16 kHz int16 → 4 kHz float ----------
struct Decimator {
    float history[64];          // >= DSP_DECIM_NTAPS
    int   phase;

    void reset();
    // Feed `n` samples at 16 kHz. Writes up to n/DECIM_FACTOR output samples.
    // Returns the number of output samples written.
    int process(const int16_t* in, int n, float* out);
};

// ---------- Core MFCC ----------
// Compute 13 x 124 MFCCs from 8000 float samples at 4 kHz.
// `out` must be float[DSP_N_MFCC][DSP_N_FRAMES] (row-major).
void compute_mfcc(const float* x8000, float out[][DSP_N_FRAMES]);

// ---------- Quantise for the int8 model ----------
// Applies per-coefficient z-score normalisation (MFCC_MEAN, MFCC_STD from model.h)
// then affine quantisation (INPUT_SCALE, INPUT_ZERO_POINT) and clamps to [-128,127].
// `mfcc_in` is float[DSP_N_MFCC][DSP_N_FRAMES], `dst` is int8_t[DSP_N_MFCC * DSP_N_FRAMES].
// Layout: row-major [mfcc_coeff][frame], matching train.py's (13, 124, 1) → flat.
void quantize_input(const float mfcc_in[][DSP_N_FRAMES],
                    const float* mean, const float* std,
                    float scale, int zero_point,
                    int8_t* dst);

// ---------- Utility ----------
// 128-point in-place radix-2 DIT FFT. re[] and im[] each have 128 elements.
void fft128(float* re, float* im);
