// cam.cpp – PneumoScreen camera stub (OV767X disabled)
//
// The OV767X library from Harvard_TinyMLx creates a global Camera object
// whose constructor runs before setup(). This hangs the board even when
// Camera.begin() is never called, because it conflicts with I2S/peripheral
// init. To enable the camera later, replace this file with cam_real.cpp.
#include "cam.h"
#include <Arduino.h>

bool cam_ok      = false;
bool cam_skipped = false;

void cam_init() {
    cam_skipped = true;
    cam_ok = false;
    Serial.println("CAM: not linked (optional)");
}

void cam_retry() {
    Serial.println("CAM: not available — rebuild with cam_real.cpp");
}

const uint8_t* cam_capture_80x60() {
    return nullptr;
}
