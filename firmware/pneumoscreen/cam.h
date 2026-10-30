// cam.h – PneumoScreen optional camera (OV7670 via TinyML Shield)
// Never hangs the board: probes 0x21 with XCLK first, arms a watchdog
// before Camera.begin(), and skips after a watchdog reset.
#pragma once
#include <stdint.h>

// Camera state
extern bool cam_ok;        // true if Camera.begin() succeeded
extern bool cam_skipped;   // true if camera was skipped (failed before or no ACK)

// Try to initialise the camera. Safe: returns quickly if no camera.
// Call after hw_init() so Wire is running.
void cam_init();

// Retry camera init on demand (serial 'X').
void cam_retry();

// Capture one 80x60 grayscale frame for breath-rate SAD.
// Returns pointer to static buffer, or nullptr if camera not available.
// The buffer is 80*60 = 4800 bytes.
const uint8_t* cam_capture_80x60();
