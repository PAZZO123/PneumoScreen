// hw.cpp – PneumoScreen hardware abstraction
#include "hw.h"
#include <Arduino.h>
#include <Wire.h>
#include "mbed.h"

bool oled_present = false;
bool spo2_present = false;
bool cam_present  = false;
bool temp_present = false;
bool safe_mode    = false;

// ── Watchdog ─────────────────────────────────────────────────
// 4-second hardware watchdog. Any hung I²C call resets the board.
// We count boot attempts in GPREGRET (survives reset, cleared on power cycle).
// Bits [3:0] = boot attempts; bits [7:4] reserved for camera marker.
#define GPREGRET_BOOT_MASK 0x0F
#define BOOT_SAFE_THRESHOLD 2

void hw_wdt_kick() {
    mbed::Watchdog::get_instance().kick();
}

void hw_boot_ok() {
    // Clear boot-attempt counter — setup() completed without hanging.
    NRF_POWER->GPREGRET = (NRF_POWER->GPREGRET & ~GPREGRET_BOOT_MASK);
    // Stop watchdog kicking requirement — we'll kick in loop() from now on.
}

// ── I2C bus recovery ─────────────────────────────────────────
// If SDA or SCL is stuck LOW, toggle SCL 9 times then send a STOP.
// This is the standard I2C bus-recovery sequence (NXP UM10204 §3.1.16).
static bool i2c_bus_recover() {
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

bool hw_probe(uint8_t addr) {
    Wire.beginTransmission(addr);
    return Wire.endTransmission() == 0;
}

// ── Public API ──────────────────────────────────────────────

bool hw_init() {
    // Start 4-second hardware watchdog immediately.
    // Any hang (I²C, sensor init) will reset the board.
    mbed::Watchdog::get_instance().start(4000);

    // Read and increment boot-attempt counter.
    uint8_t attempts = (NRF_POWER->GPREGRET & GPREGRET_BOOT_MASK) + 1;
    NRF_POWER->GPREGRET = (NRF_POWER->GPREGRET & ~GPREGRET_BOOT_MASK) | (attempts & GPREGRET_BOOT_MASK);

    // Pins
    pinMode(RED_LED_PIN, OUTPUT);
    pinMode(GREEN_LED_PIN, OUTPUT);
    pinMode(BUTTON_PIN, INPUT_PULLUP);
    // Built-in RGB LED off (active LOW)
    pinMode(LEDR, OUTPUT); digitalWrite(LEDR, HIGH);
    pinMode(LEDG, OUTPUT); digitalWrite(LEDG, HIGH);
    pinMode(LEDB, OUTPUT); digitalWrite(LEDB, HIGH);

    hw_led(0);
    hw_wdt_kick();

    if (attempts >= BOOT_SAFE_THRESHOLD) {
        safe_mode = true;
        Serial.print("SAFE_MODE: boot attempt ");
        Serial.print(attempts);
        Serial.println(" — skipping external I2C. Send 'R' to reset counter.");
        // Fast red blink 3× to signal safe mode
        for (int i = 0; i < 6; i++) {
            hw_led(i & 1 ? 1 : 0);
            delay(150);
        }
        hw_led(0);
        return true;
    }

    // Check I2C bus before Wire.begin()
    if (!i2c_bus_recover()) {
        Serial.println("ERR:I2C_STUCK");
        return false;
    }
    hw_wdt_kick();

    Wire.begin();

    // Probe devices
    oled_present = hw_probe(ADDR_OLED);
    hw_wdt_kick();
    spo2_present = hw_probe(ADDR_MAX30102);
    hw_wdt_kick();
    temp_present = hw_probe(ADDR_AHT10);
    hw_wdt_kick();
    // Camera needs XCLK running to respond — probed in cam module
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
