// hw.cpp – PneumoScreen hardware abstraction
#include "hw.h"
#include <Arduino.h>
#include <Wire.h>

bool oled_present = false;
bool spo2_present = false;
bool cam_present  = false;
bool temp_present = false;

// ── I2C bus recovery ────────────────────────────────────────
// If SDA or SCL is stuck LOW, toggle SCL 9 times then send a STOP.
// This is the standard I2C bus-recovery sequence (NXP UM10204 §3.1.16).
static bool i2c_bus_recover() {
    // Read raw pin state
    pinMode(A4, INPUT);   // SDA
    pinMode(A5, INPUT);   // SCL
    delay(5);

    bool sda = digitalRead(A4);
    bool scl = digitalRead(A5);

    if (sda && scl) return true;   // bus is idle (both HIGH)

    Serial.print("I2C: bus stuck SDA=");
    Serial.print(sda ? "H" : "L");
    Serial.print(" SCL=");
    Serial.println(scl ? "H" : "L");

    // Drive SCL as output, leave SDA as input (open-drain emulation)
    pinMode(A5, OUTPUT);
    for (int i = 0; i < 9; i++) {
        digitalWrite(A5, LOW);
        delayMicroseconds(5);
        digitalWrite(A5, HIGH);
        delayMicroseconds(5);
        // Check if SDA released
        if (digitalRead(A4) == HIGH) break;
    }
    // Generate STOP: SDA LOW → SCL HIGH → SDA HIGH
    pinMode(A4, OUTPUT);
    digitalWrite(A4, LOW);
    delayMicroseconds(5);
    digitalWrite(A5, HIGH);
    delayMicroseconds(5);
    digitalWrite(A4, HIGH);
    delayMicroseconds(5);

    // Release pins
    pinMode(A4, INPUT);
    pinMode(A5, INPUT);
    delay(5);

    sda = digitalRead(A4);
    scl = digitalRead(A5);
    Serial.print("I2C: after recovery SDA=");
    Serial.print(sda ? "H" : "L");
    Serial.print(" SCL=");
    Serial.println(scl ? "H" : "L");

    return sda && scl;
}

// Probe a single I2C address. Returns true if ACK.
static bool probe(uint8_t addr) {
    Wire.beginTransmission(addr);
    return Wire.endTransmission() == 0;
}

// ── Public API ──────────────────────────────────────────────

bool hw_init() {
    // Pins
    pinMode(RED_LED_PIN, OUTPUT);
    pinMode(GREEN_LED_PIN, OUTPUT);
    pinMode(BUTTON_PIN, INPUT_PULLUP);
    // Built-in RGB LED off (active LOW)
    pinMode(LEDR, OUTPUT); digitalWrite(LEDR, HIGH);
    pinMode(LEDG, OUTPUT); digitalWrite(LEDG, HIGH);
    pinMode(LEDB, OUTPUT); digitalWrite(LEDB, HIGH);

    hw_led(0);

    // Check I2C bus before Wire.begin()
    if (!i2c_bus_recover()) {
        Serial.println("ERR:I2C_STUCK");
        return false;
    }

    Wire.begin();
    Wire.setTimeout(25);

    // Probe devices
    oled_present = probe(ADDR_OLED);
    spo2_present = probe(ADDR_MAX30102);
    temp_present = probe(ADDR_AHT10);
    // Camera needs XCLK running to respond — probe in cam module
    cam_present  = false;

    Serial.print("HW: OLED=");
    Serial.print(oled_present ? "OK" : "--");
    Serial.print(" SpO2=");
    Serial.print(spo2_present ? "OK" : "--");
    Serial.print(" Temp=");
    Serial.print(temp_present ? "OK" : "--");
    Serial.println();

    return true;
}

bool hw_button() {
    return digitalRead(BUTTON_PIN) == LOW;
}

static bool last_btn = false;
bool hw_button_pressed() {
    bool cur = hw_button();
    bool pressed = cur && !last_btn;
    last_btn = cur;
    return pressed;
}

void hw_error_blink() {
    for (int i = 0; i < 20; i++) {
        digitalWrite(RED_LED_PIN, i & 1);
        digitalWrite(LEDR, (i & 1) ? LOW : HIGH);
        delay(150);
    }
}

void hw_led(int colour) {
    bool r = (colour == 1);
    bool g = (colour == 2);
    digitalWrite(RED_LED_PIN,   r ? HIGH : LOW);
    digitalWrite(GREEN_LED_PIN, g ? HIGH : LOW);
    digitalWrite(LEDR, r ? LOW : HIGH);
    digitalWrite(LEDG, g ? LOW : HIGH);
}
