// mfcc.cpp – Portable MFCC feature extraction for PneumoScreen
// Matches pneumo_features.mfcc() exactly. No Arduino dependencies.
#include "mfcc.h"
#include "dsp_tables.h"
#include <math.h>
#include <string.h>

// ======================= Decimator =======================

void Decimator::reset() {
    memset(history, 0, sizeof(history));
    phase = 0;
}

int Decimator::process(const int16_t* in, int n, float* out) {
    int out_count = 0;
    for (int i = 0; i < n; i++) {
        // Shift history and insert new sample (normalised to [-1, 1])
        for (int t = DSP_DECIM_NTAPS - 1; t > 0; t--)
            history[t] = history[t - 1];
        history[0] = in[i] / 32768.0f;

        phase++;
        if (phase >= DSP_DECIM_FACTOR) {
            phase = 0;
            // FIR convolution
            float acc = 0.0f;
            for (int t = 0; t < DSP_DECIM_NTAPS; t++)
                acc += DSP_DECIM_TAPS[t] * history[t];
            out[out_count++] = acc;
        }
    }
    return out_count;
}

// ======================= 128-point radix-2 DIT FFT =======================

// Bit-reversal permutation for N=128 (7 bits)
static void bit_reverse_128(float* re, float* im) {
    for (int i = 0; i < DSP_N_FFT; i++) {
        int j = 0;
        int x = i;
        for (int b = 0; b < 7; b++) {
            j = (j << 1) | (x & 1);
            x >>= 1;
        }
        if (j > i) {
            float tr = re[i]; re[i] = re[j]; re[j] = tr;
            float ti = im[i]; im[i] = im[j]; im[j] = ti;
        }
    }
}

void fft128(float* re, float* im) {
    bit_reverse_128(re, im);

    for (int s = 1; s <= 7; s++) {              // log2(128) = 7 stages
        int m = 1 << s;                          // butterfly group size
        int half = m >> 1;
        int step = DSP_N_FFT / m;                // twiddle stride

        for (int k = 0; k < DSP_N_FFT; k += m) {
            for (int j = 0; j < half; j++) {
                int tw = j * step;
                float wr = DSP_TWIDDLE_RE[tw];
                float wi = DSP_TWIDDLE_IM[tw];

                int u = k + j;
                int v = u + half;
                float tr = wr * re[v] - wi * im[v];
                float ti = wr * im[v] + wi * re[v];

                re[v] = re[u] - tr;
                im[v] = im[u] - ti;
                re[u] += tr;
                im[u] += ti;
            }
        }
    }
}

// ======================= compute_mfcc =======================

void compute_mfcc(const float* x8000, float out[][DSP_N_FRAMES]) {
    // 1. Subtract mean and RMS-normalise (matches pneumo_features.mfcc)
    float buf[DSP_WIN_SAMPLES];
    float mean = 0.0f;
    for (int i = 0; i < DSP_WIN_SAMPLES; i++) mean += x8000[i];
    mean /= DSP_WIN_SAMPLES;

    float rms = 0.0f;
    for (int i = 0; i < DSP_WIN_SAMPLES; i++) {
        buf[i] = x8000[i] - mean;
        rms += buf[i] * buf[i];
    }
    rms = sqrtf(rms / DSP_WIN_SAMPLES) + 1e-6f;
    for (int i = 0; i < DSP_WIN_SAMPLES; i++) buf[i] /= rms;

    // 2. Per-frame STFT → mel → log → DCT
    float mel_energies[DSP_N_MELS];
    float log_mel[DSP_N_MELS];
    float frame_re[DSP_N_FFT];
    float frame_im[DSP_N_FFT];

    // Track the global max log-mel energy for top_db clipping
    float global_max = -1e30f;
    // We need two passes: first compute all log-mel, then clip, then DCT.
    // To avoid a huge buffer, we store all log-mel values.
    float all_log_mel[DSP_N_FRAMES][DSP_N_MELS];

    for (int f = 0; f < DSP_N_FRAMES; f++) {
        int offset = f * DSP_HOP;

        // Apply Hann window and copy to FFT input
        for (int i = 0; i < DSP_N_FFT; i++) {
            frame_re[i] = buf[offset + i] * DSP_HANN[i];
            frame_im[i] = 0.0f;
        }

        // FFT
        fft128(frame_re, frame_im);

        // Power spectrum: |X[k]|^2 for k = 0..N_FFT/2
        float power[DSP_N_BINS];
        for (int k = 0; k < DSP_N_BINS; k++)
            power[k] = frame_re[k] * frame_re[k] + frame_im[k] * frame_im[k];

        // Mel filter bank (sparse)
        for (int m = 0; m < DSP_N_MELS; m++) {
            float e = 0.0f;
            int s = MEL_START[m];
            for (int j = 0; j < MEL_LEN[m]; j++)
                e += MEL_COEFF[m][j] * power[s + j];
            mel_energies[m] = e;
        }

        // Log mel (10 * log10, with floor to avoid log(0))
        for (int m = 0; m < DSP_N_MELS; m++) {
            float v = mel_energies[m];
            if (v < 1e-10f) v = 1e-10f;
            all_log_mel[f][m] = 10.0f * log10f(v);
            if (all_log_mel[f][m] > global_max)
                global_max = all_log_mel[f][m];
        }
    }

    // top_db = 80 clipping (librosa default): clamp to [global_max - 80, global_max]
    float floor = global_max - 80.0f;
    for (int f = 0; f < DSP_N_FRAMES; f++) {
        for (int m = 0; m < DSP_N_MELS; m++) {
            if (all_log_mel[f][m] < floor)
                all_log_mel[f][m] = floor;
        }
    }

    // DCT-II (orthonormal) → 13 MFCCs per frame
    for (int f = 0; f < DSP_N_FRAMES; f++) {
        for (int k = 0; k < DSP_N_MFCC; k++) {
            float acc = 0.0f;
            for (int m = 0; m < DSP_N_MELS; m++)
                acc += DSP_DCT[k][m] * all_log_mel[f][m];
            out[k][f] = acc;
        }
    }
}

// ======================= quantize_input =======================

void quantize_input(const float mfcc_in[][DSP_N_FRAMES],
                    const float* mean, const float* std_dev,
                    float scale, int zero_point,
                    int8_t* dst) {
    // Layout: [mfcc_coeff][frame] → flat, row-major (matches train.py)
    for (int k = 0; k < DSP_N_MFCC; k++) {
        for (int f = 0; f < DSP_N_FRAMES; f++) {
            float normed = (mfcc_in[k][f] - mean[k]) / std_dev[k];
            int q = (int)roundf(normed / scale) + zero_point;
            if (q < -128) q = -128;
            if (q > 127)  q = 127;
            dst[k * DSP_N_FRAMES + f] = (int8_t)q;
        }
    }
}
