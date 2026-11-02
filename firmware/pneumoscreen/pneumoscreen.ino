// pneumoscreen.ino – PneumoScreen v2: BLE sensor gateway
//
// The phone app runs the prompts, MFCC + lung model and keeps the records.
// The board records one step when asked (lung sound, breath, temperature)
// and sends it over BLE in numbered, CRC-checked frames. Spec: docs/BLE_PROTOCOL.md
//
// Hardware watchdog (4 s) and safe mode (stuck I2C bus / repeated boot hangs)
// are kept from v1. In safe mode external I2C sensors are skipped; the mic,
// IMU and BLE still work.
//
// Serial debug (115200): L = lung RU 10 s, A = breath 30 s, T = temperature,
// S = stop, K = done-ack, P = status, W = dump held step as F:<hex> frames,
// I = I2C scan, R = clear boot counter and reboot.
#include <Arduino.h>
#include <Wire.h>
#include "hw.h"
#include "ui.h"
#include "temp.h"
#include "gateway.h"
#include "ble_protocol.h"

static bool ble_ok = false;

static const char* STATE_TXT[] = {"Ready", "Recording", "Sending", "Sent", "Error"};
static const char* STEP_TXT[] = {"", "Breath", "Lung R-up", "Lung L-up", "Lung R-low", "Lung L-low", "Temp", "SpO2"};

static void ui_refresh(bool force) {
    static uint8_t last_state = 255, last_step = 255, last_prog = 255;
    static bool last_conn = false;
    uint8_t st = gateway_state(), sp = gateway_step(), pr = gateway_progress();
    bool conn = gateway_connected();
    if (!force && st == last_state && sp == last_step && conn == last_conn && pr / 10 == last_prog / 10) return;
    last_state = st; last_step = sp; last_prog = pr; last_conn = conn;
    char val[24];
    if (st == PS_STATE_RECORDING || st == PS_STATE_TRANSFERRING)
        snprintf(val, sizeof(val), "%s %d%%", STEP_TXT[sp < 8 ? sp : 0], pr);
    else
        snprintf(val, sizeof(val), "%s", STATE_TXT[st < 5 ? st : 4]);
    ui_step("PneumoScreen", val, !ble_ok ? "BLE error" : conn ? "Phone connected" : "Open the app");
}

static void serial_cmd(uint8_t a, uint8_t b = 0, uint16_t secs = 0) {
    uint8_t c[4] = {a, b, (uint8_t)secs, (uint8_t)(secs >> 8)};
    gateway_command(c, a == PS_OP_START_STEP ? 4 : 1);
}

static void handle_serial() {
    while (Serial.available()) {
        char c = Serial.read();
        switch (c) {
        case 'L': case 'l': serial_cmd(PS_OP_START_STEP, PS_STEP_LUNG_RU, 10); break;
        case 'A': case 'a': serial_cmd(PS_OP_START_STEP, PS_STEP_BREATH, 30); break;
        case 'T': case 't': serial_cmd(PS_OP_START_STEP, PS_STEP_TEMP, 1); break;
        case 'S': case 's': serial_cmd(PS_OP_STOP); break;
        case 'K': case 'k': serial_cmd(PS_OP_DONE_ACK); break;
        case 'P': case 'p': gateway_print_status(); break;
        case 'W': case 'w': gateway_dump_serial(); break;
        case 'R': case 'r':
            NRF_POWER->GPREGRET = 0;
            Serial.println("GPREGRET cleared — rebooting...");
            delay(100);
            NVIC_SystemReset();
            break;
        case 'I': case 'i':
            if (safe_mode) { Serial.println("I2C: scan disabled in safe mode"); break; }
            Serial.println("I2C:");
            {
                int found = 0;
                for (uint8_t a = 1; a < 127; a++) {
                    hw_wdt_kick();
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
            break;
        default: break;
        }
    }
}

void setup() {
    Serial.begin(115200);
    unsigned long t0 = millis();
    while (!Serial && millis() - t0 < 2000);
    Serial.print("=== PneumoScreen gateway v");
    Serial.print(PS_FW_MAJOR); Serial.print('.'); Serial.print(PS_FW_MINOR);
    Serial.println(" ===");

    hw_init();                       // starts watchdog; stuck bus => safe_mode
    hw_wdt_kick();
    if (safe_mode) Serial.println("SAFE MODE — external I2C sensors skipped");

    if (!safe_mode) {
        if (oled_present && !ui_init()) oled_present = false;
        hw_wdt_kick();
        temp_init();
        hw_wdt_kick();
    }

    ble_ok = gateway_init();
    hw_wdt_kick();
    if (!safe_mode) ui_refresh(true);
    hw_led(ble_ok ? 2 : 1);

    hw_boot_ok();
}

void loop() {
    hw_wdt_kick();
    handle_serial();
    if (!safe_mode) {
        bool redraw = ui_service();
        temp_service();
        ui_refresh(redraw);
    }
    if (ble_ok) gateway_update();
}
