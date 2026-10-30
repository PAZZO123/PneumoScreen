// pneumoscreen.ino – PneumoScreen integrated screening firmware
//
// State machine: BOOT → IDLE → BREATH → LUNG ×4 → RESULT
// Camera and SpO2 are optional, auto-detected, never hang the board.
//
// D13 button advances each step. OLED shows prompts and live values.
// Serial: CSV lines per step + SUMMARY line.
// LEDs: green = normal, red = refer.
#include <Arduino.h>
#include <Wire.h>
#include "hw.h"
#include "cam.h"
#include "ui.h"
#include "lung.h"
#include "breath.h"
#include "temp.h"

#ifdef PNEUMO_CAM_ENABLE
#include "mbed.h"
#endif

// ── State machine ───────────────────────────────────────────
enum State {
    ST_BOOT,
    ST_IDLE,
    ST_BREATH,
    ST_LUNG1,
    ST_LUNG2,
    ST_LUNG3,
    ST_LUNG4,
    ST_RESULT,
};

static State state = ST_BOOT;
static unsigned long state_enter_ms = 0;

// ── Results ─────────────────────────────────────────────────
static int result_bpm = 0;
static int result_spo2 = 0;
static float result_temp = 0;
static float result_humidity = 0;
static int lung_results[4] = {0};
static const char* lung_labels[4] = {"--", "--", "--", "--"};

#define LUNG_TIMEOUT_MS 15000
#define BREATH_TIMEOUT_MS 30000

void enter_state(State s);
void handle_serial();

static const char* LUNG_POS[] = {
    "Right upper", "Left upper", "Right lower", "Left lower"
};

// =====================================================================
void setup() {
    Serial.begin(115200);
    unsigned long t0 = millis();
    while (!Serial && millis() - t0 < 2000);

    Serial.println("=== PneumoScreen v1.0 ===");
    Serial.flush();

    if (!hw_init()) {
        Serial.println("FATAL: I2C bus stuck");
        if (ui_init()) ui_error("I2C BUS STUCK");
        while (1) hw_error_blink();
    }
    Serial.println("HW init OK");
    Serial.flush();

    if (oled_present) {
        if (!ui_init()) {
            oled_present = false;
            Serial.println("WARN: OLED init failed");
        } else {
            Serial.println("OLED init OK");
        }
    }
    Serial.flush();

    cam_init();
    temp_init();

    ui_boot(oled_present, cam_ok, spo2_present, temp_present);

    Serial.print("Devices: OLED=");
    Serial.print(oled_present ? "Y" : "N");
    Serial.print(" Cam=");
    Serial.print(cam_ok ? "Y" : (cam_skipped ? "skip" : "N"));
    Serial.print(" SpO2=");
    Serial.print(spo2_present ? "Y" : "N");
    Serial.print(" Temp=");
    Serial.println(temp_present ? "Y" : "N");
    Serial.println("Press D13 to start");

    state = ST_BOOT;
    state_enter_ms = millis();
}

// =====================================================================
void loop() {
#ifdef PNEUMO_CAM_ENABLE
    static bool wdt_running = false;
    if (!wdt_running && cam_ok) wdt_running = true;
    if (wdt_running) mbed::Watchdog::get_instance().kick();
#endif

    handle_serial();

    unsigned long elapsed = millis() - state_enter_ms;

    switch (state) {
    case ST_BOOT:
        if (elapsed > 2000) enter_state(ST_IDLE);
        break;

    case ST_IDLE:
        if (elapsed < 50) {
            // Read temp if available
            if (temp_present) temp_read(&result_temp, &result_humidity);
            ui_idle();
        }
        if (hw_button_pressed()) enter_state(ST_BREATH);
        break;

    case ST_BREATH:
        breath_update();
        if (elapsed % 1000 < 20) {
            ui_breath(breath_bpm(), breath_status());
        }
        if (breath_ready() && breath_bpm() > 0) {
            result_bpm = breath_bpm();
            Serial.print("BREATH: ");
            Serial.print(result_bpm);
            Serial.println(" /min");
            breath_stop();
            enter_state(ST_LUNG1);
        }
        if (hw_button_pressed() && elapsed > 5000) {
            result_bpm = breath_bpm() > 0 ? breath_bpm() : 0;
            breath_stop();
            enter_state(ST_LUNG1);
        }
        if (elapsed > BREATH_TIMEOUT_MS) {
            result_bpm = breath_bpm() > 0 ? breath_bpm() : 0;
            breath_stop();
            Serial.println("BREATH: timeout");
            enter_state(ST_LUNG1);
        }
        break;

    case ST_LUNG1:
    case ST_LUNG2:
    case ST_LUNG3:
    case ST_LUNG4: {
        int pos = state - ST_LUNG1;
        lung_update();
        if (elapsed % 1000 < 20) {
            int rem = (LUNG_TIMEOUT_MS - elapsed) / 1000;
            char st[24];
            snprintf(st, sizeof(st), "%s %ds",
                     lung_done() ? lung_class_name() : "Listening...",
                     rem > 0 ? rem : 0);
            ui_lung(pos + 1, lung_done() ? lung_class_name() : "--", st);
        }
        if (lung_done() || elapsed > LUNG_TIMEOUT_MS || hw_button_pressed()) {
            lung_results[pos] = lung_class();
            lung_labels[pos] = lung_class_name();
            lung_stop();
            Serial.print("LUNG");
            Serial.print(pos + 1);
            Serial.print(": ");
            Serial.println(lung_labels[pos]);
            State next = (State)(state + 1);
            if (next <= ST_LUNG4) enter_state(next);
            else enter_state(ST_RESULT);
        }
        break;
    }

    case ST_RESULT: {
        // Read temp one more time for result
        if (temp_present) temp_read(&result_temp, &result_humidity);

        int worst_lung = 0;
        for (int i = 0; i < 4; i++)
            if (lung_results[i] == 1 || lung_results[i] == 2)
                { worst_lung = lung_results[i]; break; }

        bool refer = (worst_lung == 1 || worst_lung == 2);
        if (result_bpm > 0) {
            const int thr[] = {60, 50, 40, 21};
            if (result_bpm >= thr[breath_get_age()]) refer = true;
        }

        const char* wl = "normal";
        for (int i = 0; i < 4; i++) {
            if (lung_results[i] == 1) { wl = "crackles"; break; }
            if (lung_results[i] == 2) { wl = "wheezes"; break; }
        }

        ui_result(result_bpm, result_spo2, wl, refer, result_temp);
        hw_led(refer ? 1 : 2);

        static bool printed = false;
        if (!printed) {
            Serial.print("SUMMARY:");
            Serial.print(millis());
            Serial.print(",bpm=");
            Serial.print(result_bpm);
            Serial.print(",spo2=");
            Serial.print(result_spo2);
            Serial.print(",temp=");
            Serial.print(result_temp, 1);
            for (int i = 0; i < 4; i++) {
                Serial.print(",lung");
                Serial.print(i + 1);
                Serial.print("=");
                Serial.print(lung_labels[i]);
            }
            Serial.print(",refer=");
            Serial.println(refer ? "YES" : "NO");
            printed = true;
        }
        if (hw_button_pressed()) {
            printed = false;
            enter_state(ST_IDLE);
        }
        break;
    }
    }
}

// =====================================================================
void enter_state(State s) {
    state = s;
    state_enter_ms = millis();
    switch (s) {
    case ST_IDLE:
        hw_led(0);
        result_bpm = 0;
        result_spo2 = 0;
        for (int i = 0; i < 4; i++) { lung_results[i] = 0; lung_labels[i] = "--"; }
        Serial.println("STATE: IDLE");
        break;
    case ST_BREATH:
        Serial.println("STATE: BREATH");
        ui_step("BREATHING RATE", "--", "Keep still, breathe");
        breath_start();
        break;
    case ST_LUNG1: case ST_LUNG2: case ST_LUNG3: case ST_LUNG4: {
        int pos = s - ST_LUNG1;
        Serial.print("STATE: LUNG "); Serial.println(pos + 1);
        char pr[32];
        snprintf(pr, sizeof(pr), "Mic at %s", LUNG_POS[pos]);
        ui_step("LUNG SOUND", LUNG_POS[pos], pr);
        lung_start();
        break;
    }
    case ST_RESULT:
        Serial.println("STATE: RESULT");
        break;
    default: break;
    }
}

// =====================================================================
void handle_serial() {
    while (Serial.available()) {
        char c = Serial.read();
        if (c == 'X' || c == 'x') cam_retry();
        else if (c == 'F') lung_handle_feed();
        else if (c >= '1' && c <= '4') {
            breath_set_age(c - '1');
            Serial.print("Age: "); Serial.println(c - '0');
        }
        else if (c == 'I' || c == 'i') {
            Serial.println("I2C:");
            int found = 0;
            for (uint8_t a = 1; a < 127; a++) {
                Wire.beginTransmission(a);
                if (Wire.endTransmission() == 0) {
                    Serial.print("  0x");
                    if (a < 16) Serial.print('0');
                    Serial.println(a, HEX);
                    found++;
                }
            }
            Serial.print("Total: ");
            Serial.println(found);
        }
    }
}
