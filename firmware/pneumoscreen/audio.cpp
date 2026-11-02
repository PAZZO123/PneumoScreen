// audio.cpp – PDM mic capture for the BLE gateway (decimation reused from mfcc.cpp)
#include "audio.h"
#include "mfcc.h"
#include "ble_protocol.h"
#include <Arduino.h>
#include <PDM.h>

#define PDM_SR       16000
#define PDM_BUF      512
#define WARMUP       (PS_AUDIO_RATE / 5)
#define LEVEL_BLOCK  (PS_AUDIO_RATE / PS_LEVEL_HZ)

static int16_t pdm_buf[PDM_BUF];
static volatile int pdm_count = 0;
static volatile bool pdm_overrun = false;

static Decimator dec;
static int16_t* out = nullptr;
static int out_len = 0, out_n = 0, skip = 0;
static bool running = false;

static float lvl_sum = 0;
static int lvl_n = 0;
static bool lvl_clip = false, lvl_new = false;
static float lvl_rms = 0;
static bool lvl_last_clip = false;

static void onPDMdata() {
    int n = PDM.available();
    if (n > (int)sizeof(pdm_buf)) n = sizeof(pdm_buf);
    if (pdm_count) pdm_overrun = true;
    PDM.read(pdm_buf, n);
    pdm_count = n / 2;
}

static bool pdm_begin() {
    PDM.onReceive(onPDMdata);
    PDM.setBufferSize(sizeof(pdm_buf));
    if (!PDM.begin(1, PDM_SR)) return false;
    PDM.setGain(20);
    return true;
}

bool audio_probe() {
    bool ok = pdm_begin();
    if (ok) PDM.end();
    return ok;
}

bool audio_start(int16_t* buf, int len) {
    out = buf;
    out_len = len;
    out_n = 0;
    skip = WARMUP;
    dec.reset();
    lvl_sum = 0; lvl_n = 0; lvl_clip = false; lvl_new = false;
    pdm_count = 0;
    pdm_overrun = false;
    running = pdm_begin();
    return running;
}

void audio_update() {
    if (!running || !pdm_count) return;
    int16_t block[PDM_BUF];
    noInterrupts();
    int n = pdm_count;
    memcpy(block, pdm_buf, n * sizeof(int16_t));
    pdm_count = 0;
    interrupts();

    float tmp[PDM_BUF / DSP_DECIM_FACTOR + 1];
    int n_out = dec.process(block, n, tmp);
    for (int i = 0; i < n_out; i++) {
        if (skip > 0) { skip--; continue; }
        float x = tmp[i];
        lvl_sum += x * x;
        if (fabsf(x) >= 0.99f) lvl_clip = true;
        if (++lvl_n >= LEVEL_BLOCK) {
            lvl_rms = sqrtf(lvl_sum / lvl_n);
            lvl_last_clip = lvl_clip;
            lvl_new = true;
            lvl_sum = 0; lvl_n = 0; lvl_clip = false;
        }
        if (out_n < out_len) {
            long v = lroundf(x * 32768.0f);
            out[out_n++] = (int16_t)constrain(v, -32768L, 32767L);
        }
    }
}

int  audio_count() { return out_n; }
bool audio_full()  { return out_n >= out_len; }
bool audio_overrun() { return pdm_overrun; }

bool audio_level(float* rms, bool* clipped) {
    if (!lvl_new) return false;
    lvl_new = false;
    *rms = lvl_rms;
    *clipped = lvl_last_clip;
    return true;
}

void audio_stop() {
    if (running) PDM.end();
    running = false;
}
