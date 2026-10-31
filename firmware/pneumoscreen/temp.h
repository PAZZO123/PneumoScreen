// temp.h – AHT10 temperature/humidity sensor
#pragma once

void temp_init();
bool temp_read(float* temp_c, float* humidity);

// Service the AHT10 connection — call once per loop().
// Re-initialises when the sensor comes back after being absent.
// Returns true when it just reconnected.
bool temp_service();
