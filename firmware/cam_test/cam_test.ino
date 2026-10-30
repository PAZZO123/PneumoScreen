// cam_test.ino – OV7670 camera test via TinyML Shield
//
// Captures QQVGA (160x120) grayscale frames and reports stats.
// Also blinks D11 red LED to confirm the sketch is running.
//
// NOTE: The OV7670 needs its XCLK signal (pin 9) running before it
// will respond on I2C. Camera.begin() provides that clock, so we
// must call it directly — we cannot pre-check I2C 0x21.
//
// Serial commands:
//   'C' -> capture one frame, print pixel stats (min/max/mean)
//   'T' -> enable OV7670 test pattern (colour bars)
//   'N' -> disable test pattern (normal camera)
//   'D' -> dump a frame as raw bytes (160*120 = 19200 bytes)
//   'I' -> run I2C scan (camera must already be init'd for 0x21 to show)
#include <Arduino_OV767X_TinyMLx.h>
#include <Wire.h>

#define RED_LED_PIN   11
#define GREEN_LED_PIN 12

// QQVGA grayscale: 160 x 120 = 19200 bytes
#define CAM_W 160
#define CAM_H 120
static uint8_t frame[CAM_W * CAM_H];

static bool cam_ok = false;

void setup() {
    Serial.begin(115200);
    unsigned long t0 = millis();
    while (!Serial && millis() - t0 < 3000);

    pinMode(RED_LED_PIN, OUTPUT);
    pinMode(GREEN_LED_PIN, OUTPUT);
    // RGB LED off
    pinMode(LEDR, OUTPUT); digitalWrite(LEDR, HIGH);
    pinMode(LEDG, OUTPUT); digitalWrite(LEDG, HIGH);
    pinMode(LEDB, OUTPUT); digitalWrite(LEDB, HIGH);

    // Red LED on during init
    digitalWrite(RED_LED_PIN, HIGH);
    digitalWrite(LEDR, LOW);

    Serial.println("=== PneumoScreen Camera Test ===");
    Serial.println("Initialising OV7670 via TinyML Shield...");
    Serial.println("(Camera.begin() starts XCLK on D9 then talks I2C to 0x21)");
    Serial.flush();

    // Set I2C timeout so Camera.begin() won't hang forever
    Wire.begin();
    Wire.setTimeout(100);

    // Camera.begin() starts XCLK, configures the camera over I2C,
    // and returns 0 (false) if the camera does not respond.
    if (!Camera.begin(QQVGA, GRAYSCALE, 1, OV7670)) {
        Serial.println("ERR: Camera.begin() failed!");
        Serial.println("Possible causes:");
        Serial.println("  - TinyML Shield not seated properly on the Nano");
        Serial.println("  - OV7670 module not plugged into the shield");
        Serial.println("  - Camera ribbon cable loose");
        Serial.println();
        Serial.println("Running I2C scan to check what's on the bus...");
        Wire.begin();
        Serial.print("I2C devices: ");
        int found = 0;
        for (uint8_t addr = 1; addr < 127; addr++) {
            Wire.beginTransmission(addr);
            if (Wire.endTransmission() == 0) {
                Serial.print("0x");
                if (addr < 16) Serial.print('0');
                Serial.print(addr, HEX);
                Serial.print(' ');
                found++;
            }
        }
        if (found == 0) Serial.print("(none)");
        Serial.println();
        Serial.println("Entering heartbeat loop. Fix wiring and press RESET.");
        cam_ok = false;
    } else {
        cam_ok = true;
        Serial.print("Camera OK: ");
        Serial.print(Camera.width());
        Serial.print("x");
        Serial.println(Camera.height());

        // I2C scan now that XCLK is running
        Serial.print("I2C devices: ");
        Wire.begin();
        for (uint8_t addr = 1; addr < 127; addr++) {
            Wire.beginTransmission(addr);
            if (Wire.endTransmission() == 0) {
                Serial.print("0x");
                if (addr < 16) Serial.print('0');
                Serial.print(addr, HEX);
                Serial.print(' ');
            }
        }
        Serial.println();

        Serial.println("Commands: C=capture, T=test pattern, N=normal, D=dump raw, I=i2c scan");
        // Green LED on = camera OK
        digitalWrite(GREEN_LED_PIN, HIGH);
        digitalWrite(LEDG, LOW);
    }

    // Red LED off after init
    digitalWrite(RED_LED_PIN, LOW);
    digitalWrite(LEDR, HIGH);
}

void loop() {
    // Blink red LED as heartbeat
    static unsigned long last_blink = 0;
    static bool red_state = false;
    if (millis() - last_blink > 500) {
        last_blink = millis();
        red_state = !red_state;
        digitalWrite(RED_LED_PIN, red_state ? HIGH : LOW);
        digitalWrite(LEDR, red_state ? LOW : HIGH);
    }

    while (Serial.available()) {
        char c = Serial.read();

        if (c == 'C' && cam_ok) {
            Serial.println("Capturing...");
            unsigned long tc = millis();
            Camera.readFrame(frame);
            tc = millis() - tc;

            // Compute stats
            uint8_t mn = 255, mx = 0;
            uint32_t sum = 0;
            for (int i = 0; i < CAM_W * CAM_H; i++) {
                if (frame[i] < mn) mn = frame[i];
                if (frame[i] > mx) mx = frame[i];
                sum += frame[i];
            }
            float avg = (float)sum / (CAM_W * CAM_H);

            Serial.print("Frame ");
            Serial.print(CAM_W);
            Serial.print("x");
            Serial.print(CAM_H);
            Serial.print(" in ");
            Serial.print(tc);
            Serial.print("ms  min=");
            Serial.print(mn);
            Serial.print(" max=");
            Serial.print(mx);
            Serial.print(" mean=");
            Serial.println(avg, 1);

            // Text histogram
            int hist[8] = {0};
            for (int i = 0; i < CAM_W * CAM_H; i++)
                hist[frame[i] >> 5]++;
            Serial.print("Histogram: ");
            for (int i = 0; i < 8; i++) {
                Serial.print(i * 32);
                Serial.print("-");
                Serial.print((i+1) * 32 - 1);
                Serial.print(":");
                Serial.print(hist[i]);
                Serial.print(" ");
            }
            Serial.println();

        } else if (c == 'T' && cam_ok) {
            Camera.testPattern();
            Serial.println("Test pattern ON");

        } else if (c == 'N' && cam_ok) {
            Camera.noTestPattern();
            Serial.println("Test pattern OFF");

        } else if (c == 'D' && cam_ok) {
            Serial.println("FRAME_START");
            Camera.readFrame(frame);
            Serial.write(frame, CAM_W * CAM_H);
            Serial.println();
            Serial.println("FRAME_END");

        } else if (c == 'I') {
            Wire.begin();
            Serial.print("I2C: ");
            for (uint8_t addr = 1; addr < 127; addr++) {
                Wire.beginTransmission(addr);
                if (Wire.endTransmission() == 0) {
                    Serial.print("0x");
                    if (addr < 16) Serial.print('0');
                    Serial.print(addr, HEX);
                    Serial.print(' ');
                }
            }
            Serial.println();
        }
    }
}
