// lung.cpp – STUB to test boot without TFLite
// Full implementation in lung_full.cpp.bak
#include "lung.h"
#include "model.h"
#include <Arduino.h>

static bool is_done = false;
static int best_class = 0;
static float avg_probs[N_CLASSES] = {0};

void lung_start() {
    is_done = false;
    best_class = 0;
    memset(avg_probs, 0, sizeof(avg_probs));
    Serial.println("LUNG: stub started (no TFLite)");
}

void lung_update() {
    // Auto-complete after a short delay for testing
    static unsigned long start_ms = 0;
    if (!is_done) {
        if (start_ms == 0) start_ms = millis();
        if (millis() - start_ms > 3000) {
            avg_probs[0] = 0.9f;
            best_class = 0;
            is_done = true;
            start_ms = 0;
        }
    }
}

bool lung_done() { return is_done; }
int lung_class() { return best_class; }
const char* lung_class_name() { return CLASS_NAMES[best_class]; }
const float* lung_probs() { return avg_probs; }

void lung_stop() {
    is_done = false;
    Serial.println("LUNG: stub stopped");
}

void lung_handle_feed() {
    Serial.println("FEED: not available in stub mode");
}
