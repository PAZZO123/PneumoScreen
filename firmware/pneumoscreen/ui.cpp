// ui.cpp – PneumoScreen OLED UI
#include "ui.h"
#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_W 128
#define SCREEN_H  64
#define OLED_ADDR 0x3C

static Adafruit_SSD1306 disp(SCREEN_W, SCREEN_H, &Wire, -1);
static bool disp_ok = false;

// ── Helpers ─────────────────────────────────────────────────
static void banner() {
    disp.setTextColor(SSD1306_WHITE);
    disp.setTextSize(2);
    disp.setCursor(4, 0);
    disp.print("Pneumo");
    disp.setCursor(4, 18);
    disp.print("Screen");
    disp.drawLine(0, 38, 127, 38, SSD1306_WHITE);
}

static void status_lines(const char* s1, const char* s2) {
    disp.setTextSize(1);
    disp.setCursor(0, 42);
    if (s1) disp.print(s1);
    disp.setCursor(0, 52);
    if (s2) disp.print(s2);
}

// ── Public API ──────────────────────────────────────────────

bool ui_init() {
    if (disp.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
        disp_ok = true;
        disp.clearDisplay();
        disp.display();
        return true;
    }
    return false;
}

void ui_boot(bool oled_ok, bool cam, bool spo2, bool temp) {
    if (!disp_ok) return;
    disp.clearDisplay();
    banner();

    char line1[22], line2[22];
    snprintf(line1, sizeof(line1), "OLED:%s Cam:%s",
             oled_ok ? "OK" : "--", cam ? "OK" : "--");
    snprintf(line2, sizeof(line2), "SpO2:%s Tmp:%s",
             spo2 ? "OK" : "--", temp ? "OK" : "--");
    status_lines(line1, line2);
    disp.display();
}

void ui_idle() {
    if (!disp_ok) return;
    disp.clearDisplay();
    banner();
    status_lines("Ready", "Press button to start");
    disp.display();
}

void ui_step(const char* title, const char* value, const char* prompt) {
    if (!disp_ok) return;
    disp.clearDisplay();
    disp.setTextColor(SSD1306_WHITE);
    // Title bar
    disp.setTextSize(1);
    disp.setCursor(0, 0);
    disp.print(title);
    disp.drawLine(0, 10, 127, 10, SSD1306_WHITE);
    // Value centred
    disp.setTextSize(2);
    int16_t x1, y1; uint16_t w, h;
    disp.getTextBounds(value, 0, 0, &x1, &y1, &w, &h);
    disp.setCursor((SCREEN_W - w) / 2, 22);
    disp.print(value);
    // Prompt at bottom
    disp.setTextSize(1);
    disp.setCursor(0, 54);
    disp.print(prompt);
    disp.display();
}

void ui_breath(int bpm, const char* status) {
    char val[16];
    if (bpm > 0) snprintf(val, sizeof(val), "%d /min", bpm);
    else         snprintf(val, sizeof(val), "--");
    ui_step("BREATHING RATE", val, status);
}

void ui_spo2(int spo2_pct, int hr_bpm, const char* status) {
    char val[22];
    if (spo2_pct > 0)
        snprintf(val, sizeof(val), "%d%%  HR:%d", spo2_pct, hr_bpm);
    else
        snprintf(val, sizeof(val), "--");
    ui_step("PULSE OXIMETRY", val, status);
}

void ui_lung(int position, const char* label, const char* status) {
    char title[24];
    snprintf(title, sizeof(title), "LUNG %d/4: %s", position,
             position <= 2 ? "UPPER" : "LOWER");
    ui_step(title, label, status);
}

void ui_result(int bpm, int spo2, const char* lung_class, bool refer, float temp_c) {
    if (!disp_ok) return;
    disp.clearDisplay();
    disp.setTextColor(SSD1306_WHITE);

    // Title
    disp.setTextSize(1);
    disp.setCursor(0, 0);
    disp.print(refer ? "!! REFER !!" : "RESULT: OK");
    disp.drawLine(0, 10, 127, 10, SSD1306_WHITE);

    // Data
    disp.setCursor(0, 14);
    char line[24];
    snprintf(line, sizeof(line), "Breath: %d /min", bpm);
    disp.println(line);
    if (temp_c > 0) {
        int ti = (int)temp_c;
        int td = (int)((temp_c - ti) * 10);
        if (td < 0) td = -td;
        snprintf(line, sizeof(line), "Temp:   %d.%dC", ti, td);
        disp.println(line);
    } else if (spo2 > 0) {
        snprintf(line, sizeof(line), "SpO2:   %d%%", spo2);
        disp.println(line);
    } else {
        disp.println("Temp:   --");
    }
    snprintf(line, sizeof(line), "Lung:   %s", lung_class);
    disp.println(line);

    // Big referral indicator
    disp.setTextSize(2);
    disp.setCursor(0, 46);
    disp.print(refer ? "REFER" : "NORMAL");
    disp.display();
}

void ui_error(const char* msg) {
    if (!disp_ok) return;
    disp.clearDisplay();
    disp.setTextColor(SSD1306_WHITE);
    disp.setTextSize(2);
    disp.setCursor(0, 0);
    disp.print("ERROR");
    disp.setTextSize(1);
    disp.setCursor(0, 24);
    disp.print(msg);
    disp.display();
}

void ui_countdown(int seconds) {
    if (!disp_ok) return;
    char buf[4];
    snprintf(buf, sizeof(buf), "%d", seconds);
    disp.fillRect(48, 20, 32, 24, SSD1306_BLACK);
    disp.setTextColor(SSD1306_WHITE);
    disp.setTextSize(3);
    disp.setCursor(52, 22);
    disp.print(buf);
    disp.display();
}

void ui_clear() {
    if (!disp_ok) return;
    disp.clearDisplay();
    disp.display();
}
