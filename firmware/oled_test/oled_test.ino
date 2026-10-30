// oled_test.ino – PneumoScreen demo: OLED display + LEDs + I2C probe
//
// Shows "PneumoScreen" on the SSD1306 OLED with live status.
// Probes camera at 0x21 by toggling XCLK (D9) manually.
// Blinks D11 red / D12 green LEDs.
//
// Serial: I=scan, P=pins, T=test, X=probe camera
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define RED_LED_PIN   11
#define GREEN_LED_PIN 12
#define BUTTON_PIN    13
#define XCLK_PIN      9

#define SCREEN_W 128
#define SCREEN_H  64
#define OLED_ADDR 0x3C

Adafruit_SSD1306 display(SCREEN_W, SCREEN_H, &Wire, -1);
static bool oled_ok = false;
static bool cam_found = false;

void oled_draw(const char* s1, const char* s2) {
    if (!oled_ok) return;
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(2);
    display.setCursor(4, 0);
    display.println("Pneumo");
    display.setCursor(4, 18);
    display.println("Screen");
    display.drawLine(0, 38, 127, 38, SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(0, 42);
    display.println(s1);
    display.setCursor(0, 52);
    display.println(s2);
    display.display();
}

void do_i2c_scan() {
    Serial.println("I2C scan:");
    int found = 0;
    for (uint8_t addr = 1; addr < 127; addr++) {
        Wire.beginTransmission(addr);
        if (Wire.endTransmission() == 0) {
            Serial.print("  0x");
            if (addr < 16) Serial.print('0');
            Serial.print(addr, HEX);
            if      (addr == 0x21) Serial.print("  OV7670");
            else if (addr == 0x3C) Serial.print("  SSD1306");
            else if (addr == 0x57) Serial.print("  MAX30102");
            Serial.println();
            found++;
        }
    }
    if (found == 0) Serial.println("  (none)");
    Serial.print("Total: ");
    Serial.println(found);
}

void probe_camera() {
    Serial.println("Starting XCLK on D9...");
    // Start PWM on XCLK pin to wake the OV7670
    analogWrite(XCLK_PIN, 128);
    delay(200);

    Wire.beginTransmission(0x21);
    uint8_t err = Wire.endTransmission();

    if (err == 0) {
        cam_found = true;
        Serial.println("OV7670 found at 0x21!");
        oled_draw("OLED:OK  Cam:0x21", "Camera detected!");
    } else {
        cam_found = false;
        Serial.print("Camera not at 0x21 (err=");
        Serial.print(err);
        Serial.println(")");
        oled_draw("OLED:OK  Cam:--", "No camera at 0x21");
        do_i2c_scan();
    }
    // Stop XCLK
    analogWrite(XCLK_PIN, 0);
    digitalWrite(XCLK_PIN, LOW);
}

void setup() {
    Serial.begin(115200);
    unsigned long t0 = millis();
    while (!Serial && millis() - t0 < 3000);

    pinMode(RED_LED_PIN, OUTPUT);
    pinMode(GREEN_LED_PIN, OUTPUT);
    pinMode(BUTTON_PIN, INPUT_PULLUP);
    pinMode(LEDR, OUTPUT); digitalWrite(LEDR, HIGH);
    pinMode(LEDG, OUTPUT); digitalWrite(LEDG, HIGH);
    pinMode(LEDB, OUTPUT); digitalWrite(LEDB, HIGH);

    Wire.begin();

    Serial.println("=== PneumoScreen Demo ===");

    // --- OLED ---
    if (display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
        oled_ok = true;
        Serial.println("OLED OK at 0x3C");
        oled_draw("OLED: OK", "Probing camera...");
    } else {
        Serial.println("ERR: OLED not found!");
    }

    // Camera probe skipped at boot — send 'X' to try it
    oled_draw("OLED: OK", "Send X to probe cam");

    Serial.println("Commands: I=scan P=pins T=test X=camera");
    Serial.println("LEDs blinking...");
}

static unsigned long last_blink = 0;
static bool red_on = false;
static unsigned long oled_tick = 0;

void loop() {
    // LED blink
    if (millis() - last_blink > 500) {
        last_blink = millis();
        red_on = !red_on;
        digitalWrite(RED_LED_PIN, red_on);
        digitalWrite(GREEN_LED_PIN, !red_on);
        digitalWrite(LEDR, red_on ? LOW : HIGH);
        digitalWrite(LEDG, red_on ? HIGH : LOW);
    }

    // Update OLED status every 2s
    if (oled_ok && millis() - oled_tick > 2000) {
        oled_tick = millis();
        unsigned long s = millis() / 1000;
        display.fillRect(0, 52, 128, 12, SSD1306_BLACK);
        display.setTextSize(1);
        display.setCursor(0, 52);
        display.print("Up:");
        display.print(s);
        display.print("s Btn:");
        display.print(digitalRead(BUTTON_PIN) == LOW ? "ON " : "-- ");
        display.print(cam_found ? "Cam:Y" : "Cam:N");
        display.display();
    }

    // Serial commands
    while (Serial.available()) {
        char c = Serial.read();
        if (c == 'I' || c == 'i') do_i2c_scan();
        else if (c == 'X' || c == 'x') probe_camera();
        else if (c == 'P' || c == 'p') {
            Wire.end();
            pinMode(A4, INPUT); pinMode(A5, INPUT);
            delay(10);
            Serial.print("A4=");
            Serial.print(digitalRead(A4) ? "H" : "L");
            Serial.print(" A5=");
            Serial.println(digitalRead(A5) ? "H" : "L");
            Wire.begin();
        } else if (c == 'T' || c == 't') {
            if (oled_ok) {
                display.clearDisplay();
                for (int y = 0; y < SCREEN_H; y += 8)
                    for (int x = 0; x < SCREEN_W; x += 8)
                        if (((x/8)+(y/8))%2==0)
                            display.fillRect(x,y,8,8,SSD1306_WHITE);
                display.display();
                Serial.println("Test pattern");
            }
        }
    }
}
