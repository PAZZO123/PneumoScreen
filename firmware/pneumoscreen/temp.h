// temp.h – AHT10 temperature/humidity sensor
#pragma once

void temp_init();
bool temp_read(float* temp_c, float* humidity);
