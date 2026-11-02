// audio.h – PDM mic capture: 16 kHz PDM → 63-tap FIR → 4 kHz int16 into a caller buffer
#pragma once
#include <stdint.h>

// Probe the mic once at boot (start + stop PDM). Returns true if PDM started.
bool audio_probe();

// Start recording into buf (len samples). Discards the first 200 ms (PDM warm-up).
bool audio_start(int16_t* buf, int len);

// Call every loop iteration while recording.
void audio_update();

int  audio_count();
bool audio_full();

// New 100 ms level available? rms of the [-1, 1] signal, clipped if |x| >= 0.99.
bool audio_level(float* rms, bool* clipped);

// True if a PDM block was dropped (loop() too slow) since audio_start().
bool audio_overrun();

void audio_stop();
