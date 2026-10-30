// mfcc_host.cpp – PC-side MFCC computation using the same mfcc.cpp as the board.
// Build:  g++ -O2 -I firmware/lung_sound tools/mfcc_host.cpp firmware/lung_sound/mfcc.cpp -lm -o mfcc_host
// Usage:  ./mfcc_host < input.f32 > output.f32
//   input  : 8000 float32 samples at 4 kHz (little-endian)
//   output : 13 x 124 float32 MFCC values (row-major: [coeff][frame])
#include <cstdio>
#include <cstdlib>
#include "mfcc.h"

int main() {
    float x[DSP_WIN_SAMPLES];
    size_t n = fread(x, sizeof(float), DSP_WIN_SAMPLES, stdin);
    if ((int)n < DSP_WIN_SAMPLES) {
        // Zero-pad if the input is shorter
        for (size_t i = n; i < DSP_WIN_SAMPLES; i++) x[i] = 0.0f;
    }

    float mfcc_out[DSP_N_MFCC][DSP_N_FRAMES];
    compute_mfcc(x, mfcc_out);

    fwrite(mfcc_out, sizeof(float), DSP_N_MFCC * DSP_N_FRAMES, stdout);
    return 0;
}
