// fixture_host.cpp – reference pipeline for the TS parity tests, using the
// firmware's own mfcc.cpp. Build (see scripts/make_fixtures.py):
//   g++ -O2 -ffp-contract=off -I firmware/pneumoscreen shared/dsp/scripts/fixture_host.cpp \
//       firmware/pneumoscreen/mfcc.cpp -lm -o fixture_host
// stdin : u32 n, then n windows of 32000 int16 @ 16 kHz
// stdout: per window, f32[8000] decimated, i16[8000] pcm4k (as the board sends it),
//         f32[13*124] mfcc of pcm4k/32768, i8[13*124] quantized input
#include <cmath>
#include <cstdint>
#include <cstdio>
#include "mfcc.h"
#include "dsp_tables.h"
#include "model.h"

int main() {
    uint32_t n = 0;
    if (fread(&n, 4, 1, stdin) != 1) return 1;
    static int16_t in[32000];
    static float dec_out[8000 + 8], x4[8000];
    static int16_t pcm[8000];
    static float mfcc_out[DSP_N_MFCC][DSP_N_FRAMES];
    static int8_t q[DSP_N_MFCC * DSP_N_FRAMES];
    for (uint32_t w = 0; w < n; w++) {
        if (fread(in, 2, 32000, stdin) != 32000) return 2;
        Decimator d;
        d.reset();
        int got = 0;
        for (int i = 0; i < 32000; i += 512) {
            int len = 32000 - i < 512 ? 32000 - i : 512;
            got += d.process(in + i, len, dec_out + got);
        }
        if (got != 8000) return 3;
        for (int i = 0; i < 8000; i++) {
            long v = lroundf(dec_out[i] * 32768.0f);
            if (v < -32768) v = -32768;
            if (v > 32767) v = 32767;
            pcm[i] = (int16_t)v;
            x4[i] = pcm[i] / 32768.0f;
        }
        compute_mfcc(x4, mfcc_out);
        quantize_input(mfcc_out, MFCC_MEAN, MFCC_STD, INPUT_SCALE, INPUT_ZERO_POINT, q);
        fwrite(dec_out, 4, 8000, stdout);
        fwrite(pcm, 2, 8000, stdout);
        fwrite(mfcc_out, 4, DSP_N_MFCC * DSP_N_FRAMES, stdout);
        fwrite(q, 1, DSP_N_MFCC * DSP_N_FRAMES, stdout);
    }
    return 0;
}
