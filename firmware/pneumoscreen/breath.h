// breath.h – PneumoScreen non-blocking accelerometer breath rate
// Adapted from firmware/breath_rate/breath_rate.ino with Phase 4a fixes.
#pragma once

// Start breath-rate measurement. Initialises IMU, resets buffers.
void breath_start();

// Call every loop iteration. Samples the IMU, fills the buffer, runs analysis.
void breath_update();

// Returns true when a stable breath rate estimate is available.
bool breath_ready();

// Breath rate in breaths/min (median-filtered). 0 if not ready.
int breath_bpm();

// Signal quality (0.0–1.0). Higher = more confident.
float breath_quality();

// Signal std deviation in mg.
float breath_signal_mg();

// Status string ("Measuring...", "Normal", "FAST", "Too much movement", etc.)
const char* breath_status();

// Stop the IMU.
void breath_stop();

// Age group for WHO IMCI thresholds. 0=<2mo, 1=2-12mo, 2=1-5y, 3=adult
void breath_set_age(int idx);
int  breath_get_age();
