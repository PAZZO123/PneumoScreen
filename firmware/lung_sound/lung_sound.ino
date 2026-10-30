// lung_sound.ino – PneumoScreen Phase 3: on-device lung-sound classification
//
// PDM microphone (16 kHz) → decimate to 4 kHz → 2 s MFCC window → int8 CNN
// → softmax → D11 red (crackles/wheezes) or D12 green (normal).
//
// Serial output: CSV:LUNG,<ms>,<label>,<p0>,<p1>,<p2>,<p3>,<us_dsp>,<us_infer>
// Shield button D13 restarts the 10 s averaging period.
//
// Feed mode: PC sends 'F' + 32000 int16 samples (2 s at 16 kHz).
//   Board decimates, computes features, runs inference, and returns the result.
#include <PDM.h>

// TFLite Micro (Chirale_TensorFLowLite 2.0.0)
#include <Chirale_TensorFlowLite.h>
#include <tensorflow/lite/micro/all_ops_resolver.h>
#include <tensorflow/lite/micro/micro_interpreter.h>
#include <tensorflow/lite/schema/schema_generated.h>

#include "model.h"
#include "mfcc.h"
#include "dsp_tables.h"

// ---- Pin definitions ----
#define RED_LED_PIN   11
#define GREEN_LED_PIN 12
#define BUTTON_PIN    13

// ---- PDM / audio ----
#define PDM_SR        16000
#define PDM_BUF_SIZE  512
static int16_t pdm_buf[PDM_BUF_SIZE];
static volatile int pdm_count = 0;

// Ring buffer for 4 kHz decimated audio (2 s = 8000 samples)
static float ring4k[DSP_WIN_SAMPLES];
static int   ring4k_head = 0;               // next write index
static int   ring4k_filled = 0;             // how many valid samples we have
static Decimator decimator;

// ---- TFLite Micro ----
static constexpr int kArenaSize = 48 * 1024;
static uint8_t tensor_arena[kArenaSize] __attribute__((aligned(16)));
static tflite::AllOpsResolver resolver;
static const tflite::Model* model = nullptr;
static tflite::MicroInterpreter* interpreter = nullptr;
static TfLiteTensor* input_tensor  = nullptr;
static TfLiteTensor* output_tensor = nullptr;

// ---- Inference state ----
static unsigned long last_inference_ms = 0;
#define INFERENCE_INTERVAL_MS 1000           // 1 s (50 % overlap of 2 s window)
#define RESULT_WINDOWS        10             // average over 10 windows (10 s)

static float softmax_accum[N_CLASSES] = {0};
static int   window_count = 0;

// Silence gate: if RMS of the raw 4 kHz window is below this, skip inference
#define SILENCE_RMS_THRESHOLD 0.005f

// ---- Feed mode ----
static bool feed_mode = false;
#define FEED_SAMPLES (2 * PDM_SR)            // 32000 int16 at 16 kHz

// ---- Forward declarations ----
void onPDMdata();
void run_inference_on_window(const float* window, bool print_features);
void show_result();
void set_leds(int cls);

// =====================================================================
void setup() {
    Serial.begin(115200);
    while (!Serial);

    pinMode(RED_LED_PIN, OUTPUT);
    pinMode(GREEN_LED_PIN, OUTPUT);
    pinMode(BUTTON_PIN, INPUT_PULLUP);

    // Built-in RGB LED (active LOW)
    pinMode(LEDR, OUTPUT); digitalWrite(LEDR, HIGH);
    pinMode(LEDG, OUTPUT); digitalWrite(LEDG, HIGH);
    pinMode(LEDB, OUTPUT); digitalWrite(LEDB, HIGH);

    // ---- TFLite Micro setup ----
    model = tflite::GetModel(model_tflite);
    if (model->version() != TFLITE_SCHEMA_VERSION) {
        Serial.print("ERR: model schema ");
        Serial.print(model->version());
        Serial.print(" != runtime ");
        Serial.println(TFLITE_SCHEMA_VERSION);
        while (1);
    }

    static tflite::MicroInterpreter static_interpreter(
        model, resolver, tensor_arena, kArenaSize);
    interpreter = &static_interpreter;

    if (interpreter->AllocateTensors() != kTfLiteOk) {
        Serial.println("ERR: AllocateTensors failed");
        while (1);
    }

    input_tensor  = interpreter->input(0);
    output_tensor = interpreter->output(0);

    Serial.print("Arena used: ");
    Serial.print(interpreter->arena_used_bytes());
    Serial.print(" / ");
    Serial.println(kArenaSize);
    Serial.print("Input shape: ");
    for (int i = 0; i < input_tensor->dims->size; i++) {
        if (i) Serial.print('x');
        Serial.print(input_tensor->dims->data[i]);
    }
    Serial.print(" (type ");
    Serial.print(input_tensor->type);
    Serial.println(')');

    // ---- Decimator ----
    decimator.reset();
    memset(ring4k, 0, sizeof(ring4k));

    // ---- PDM microphone ----
    PDM.onReceive(onPDMdata);
    PDM.setBufferSize(PDM_BUF_SIZE * 2);
    if (!PDM.begin(1, PDM_SR)) {
        Serial.println("ERR: PDM failed");
        while (1);
    }
    PDM.setGain(20);

    Serial.println("READY lung_sound v1");
    last_inference_ms = millis();
}

// =====================================================================
void loop() {
    // ---- Serial commands ----
    while (Serial.available()) {
        char c = Serial.read();
        if (c == 'F') {
            handle_feed_mode();
            continue;
        }
    }

    // ---- Button: restart averaging ----
    static bool last_btn = HIGH;
    bool btn = digitalRead(BUTTON_PIN);
    if (btn == LOW && last_btn == HIGH) {
        Serial.println("BUTTON: restart averaging");
        memset(softmax_accum, 0, sizeof(softmax_accum));
        window_count = 0;
    }
    last_btn = btn;

    // ---- Decimate new PDM samples ----
    if (pdm_count > 0) {
        int16_t tmp[PDM_BUF_SIZE];
        noInterrupts();
        int n = pdm_count;
        memcpy(tmp, pdm_buf, n * 2);
        pdm_count = 0;
        interrupts();

        float dec_out[PDM_BUF_SIZE / DSP_DECIM_FACTOR + 1];
        int n_out = decimator.process(tmp, n, dec_out);

        // Push into ring buffer
        for (int i = 0; i < n_out; i++) {
            ring4k[ring4k_head] = dec_out[i];
            ring4k_head = (ring4k_head + 1) % DSP_WIN_SAMPLES;
            if (ring4k_filled < DSP_WIN_SAMPLES) ring4k_filled++;
        }
    }

    // ---- Periodic inference ----
    unsigned long now = millis();
    if (now - last_inference_ms >= INFERENCE_INTERVAL_MS &&
        ring4k_filled >= DSP_WIN_SAMPLES) {
        last_inference_ms = now;

        // Linearise the ring buffer into a contiguous window
        float window[DSP_WIN_SAMPLES];
        int start = (ring4k_head - DSP_WIN_SAMPLES + DSP_WIN_SAMPLES * 2) % DSP_WIN_SAMPLES;
        for (int i = 0; i < DSP_WIN_SAMPLES; i++)
            window[i] = ring4k[(start + i) % DSP_WIN_SAMPLES];

        // Silence gate
        float rms = 0.0f;
        for (int i = 0; i < DSP_WIN_SAMPLES; i++) rms += window[i] * window[i];
        rms = sqrtf(rms / DSP_WIN_SAMPLES);
        if (rms < SILENCE_RMS_THRESHOLD) {
            Serial.print("CSV:LUNG,");
            Serial.print(now);
            Serial.println(",silence,0,0,0,0,0,0");
            set_leds(-1);   // both off
            return;
        }

        run_inference_on_window(window, false);
    }
}

// =====================================================================
void onPDMdata() {
    int bytes = PDM.available();
    PDM.read(pdm_buf, bytes);
    pdm_count = bytes / 2;
}

// =====================================================================
void run_inference_on_window(const float* window, bool print_features) {
    unsigned long t0 = micros();

    // MFCC
    float mfcc_out[DSP_N_MFCC][DSP_N_FRAMES];
    compute_mfcc(window, mfcc_out);

    unsigned long t1 = micros();

    // Quantise into the model's input tensor
    quantize_input(mfcc_out, MFCC_MEAN, MFCC_STD,
                   INPUT_SCALE, INPUT_ZERO_POINT,
                   input_tensor->data.int8);

    // Inference
    unsigned long t2 = micros();
    if (interpreter->Invoke() != kTfLiteOk) {
        Serial.println("ERR: Invoke failed");
        return;
    }
    unsigned long t3 = micros();

    // Read softmax output (int8, dequantise)
    float probs[N_CLASSES];
    float out_scale = output_tensor->params.scale;
    int   out_zp    = output_tensor->params.zero_point;
    for (int i = 0; i < N_CLASSES; i++)
        probs[i] = (output_tensor->data.int8[i] - out_zp) * out_scale;

    // Find best class
    int best = 0;
    for (int i = 1; i < N_CLASSES; i++)
        if (probs[i] > probs[best]) best = i;

    unsigned long us_dsp   = t1 - t0;
    unsigned long us_quant = t2 - t1;
    unsigned long us_infer = t3 - t2;

    // CSV output
    unsigned long now = millis();
    Serial.print("CSV:LUNG,");
    Serial.print(now);
    Serial.print(',');
    Serial.print(CLASS_NAMES[best]);
    for (int i = 0; i < N_CLASSES; i++) {
        Serial.print(',');
        Serial.print(probs[i], 4);
    }
    Serial.print(',');
    Serial.print(us_dsp + us_quant);
    Serial.print(',');
    Serial.println(us_infer);

    // LEDs
    set_leds(best);

    // Accumulate for 10 s result
    for (int i = 0; i < N_CLASSES; i++) softmax_accum[i] += probs[i];
    window_count++;
    if (window_count >= RESULT_WINDOWS) {
        show_result();
        memset(softmax_accum, 0, sizeof(softmax_accum));
        window_count = 0;
    }

    // Optionally print features (feed mode)
    if (print_features) {
        Serial.println("FEATURES:");
        for (int k = 0; k < DSP_N_MFCC; k++) {
            for (int f = 0; f < DSP_N_FRAMES; f++) {
                if (f) Serial.print(',');
                Serial.print(mfcc_out[k][f], 4);
            }
            Serial.println();
        }
        Serial.println("END_FEATURES");
    }
}

// =====================================================================
void show_result() {
    float avg[N_CLASSES];
    for (int i = 0; i < N_CLASSES; i++) avg[i] = softmax_accum[i] / window_count;

    int best = 0;
    for (int i = 1; i < N_CLASSES; i++)
        if (avg[i] > avg[best]) best = i;

    Serial.print("RESULT,");
    Serial.print(millis());
    Serial.print(',');
    Serial.print(CLASS_NAMES[best]);
    for (int i = 0; i < N_CLASSES; i++) {
        Serial.print(',');
        Serial.print(avg[i], 4);
    }
    Serial.print(',');
    Serial.println(window_count);
}

// =====================================================================
void set_leds(int cls) {
    // cls: 0=normal(green), 1=crackles(red), 2=wheezes(red), 3=noise(off), -1=silence(off)
    bool red = (cls == 1 || cls == 2);
    bool grn = (cls == 0);
    digitalWrite(RED_LED_PIN,   red ? HIGH : LOW);
    digitalWrite(GREEN_LED_PIN, grn ? HIGH : LOW);
    // RGB LED mirrors (active LOW)
    digitalWrite(LEDR, red ? LOW : HIGH);
    digitalWrite(LEDG, grn ? LOW : HIGH);
}

// =====================================================================
void handle_feed_mode() {
    // Read 32000 int16 samples from serial (2 s at 16 kHz)
    Serial.println("FEED: waiting for 32000 int16 samples...");
    int16_t* feed_buf = (int16_t*)malloc(FEED_SAMPLES * sizeof(int16_t));
    if (!feed_buf) {
        Serial.println("ERR: feed malloc failed");
        return;
    }

    // Stop PDM while in feed mode
    PDM.end();

    size_t bytes_needed = FEED_SAMPLES * 2;
    uint8_t* ptr = (uint8_t*)feed_buf;
    unsigned long deadline = millis() + 10000;   // 10 s timeout
    size_t received = 0;
    while (received < bytes_needed && millis() < deadline) {
        if (Serial.available()) {
            ptr[received++] = Serial.read();
        }
    }

    if (received < bytes_needed) {
        Serial.print("ERR: feed timeout, got ");
        Serial.print(received);
        Serial.print(" / ");
        Serial.println(bytes_needed);
        free(feed_buf);
        // Restart PDM
        PDM.onReceive(onPDMdata);
        PDM.setBufferSize(PDM_BUF_SIZE * 2);
        PDM.begin(1, PDM_SR);
        PDM.setGain(20);
        return;
    }

    Serial.println("FEED: received, processing...");

    // Decimate to 4 kHz
    Decimator feed_dec;
    feed_dec.reset();
    float window[DSP_WIN_SAMPLES];
    int total_out = 0;
    // Process in chunks
    int chunk = 512;
    for (int i = 0; i < FEED_SAMPLES && total_out < DSP_WIN_SAMPLES; i += chunk) {
        int n = min(chunk, FEED_SAMPLES - i);
        float tmp_out[chunk / DSP_DECIM_FACTOR + 1];
        int n_out = feed_dec.process(feed_buf + i, n, tmp_out);
        for (int j = 0; j < n_out && total_out < DSP_WIN_SAMPLES; j++)
            window[total_out++] = tmp_out[j];
    }
    // Zero-pad if needed
    for (int i = total_out; i < DSP_WIN_SAMPLES; i++) window[i] = 0.0f;

    free(feed_buf);

    // Run inference with feature printing
    run_inference_on_window(window, true);

    // Restart PDM
    decimator.reset();
    ring4k_head = 0;
    ring4k_filled = 0;
    PDM.onReceive(onPDMdata);
    PDM.setBufferSize(PDM_BUF_SIZE * 2);
    PDM.begin(1, PDM_SR);
    PDM.setGain(20);

    Serial.println("FEED: done, live mode resumed");
}
