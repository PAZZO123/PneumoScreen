// ui.h – PneumoScreen OLED UI (SSD1306 128x64)
#pragma once

// Initialise the OLED. Returns true if display found.
bool ui_init();

// ── Screen drawing functions ────────────────────────────────

// Boot screen: shows "PneumoScreen" banner + device status
void ui_boot(bool oled_ok, bool cam_ok, bool spo2_ok, bool temp_ok = false);

// Idle screen: "Press button to start"
void ui_idle();

// Generic step screen: title on top, value in the middle, prompt at bottom
void ui_step(const char* title, const char* value, const char* prompt);

// Breath rate screen
void ui_breath(int bpm, const char* status);

// SpO2 screen
void ui_spo2(int spo2_pct, int hr_bpm, const char* status);

// Lung auscultation screen (position 1-4)
void ui_lung(int position, const char* label, const char* status);

// Result / summary screen
void ui_result(int bpm, int spo2, const char* lung_class, bool refer, float temp_c = 0);

// Error screen
void ui_error(const char* msg);

// Countdown overlay: shows a number in the centre
void ui_countdown(int seconds);

// Clear the display
void ui_clear();

// Service the OLED connection — call once per loop().
// Probes 0x3C every ~1 s. Returns true when the display just reconnected
// (caller should set force_redraw and repaint the current screen).
bool ui_service();
