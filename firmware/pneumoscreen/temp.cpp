// temp.cpp – AHT10 temperature/humidity via direct I2C
#include "temp.h"
#include "hw.h"
#include <Arduino.h>
#include <Wire.h>

static bool aht_ok = false;

void temp_init() {
    if (!temp_present) {
        Serial.println("TEMP: not found");
        return;
    }
    // AHT10 init: send calibrate command 0xE1 with params 0x08, 0x00
    Wire.beginTransmission(ADDR_AHT10);
    Wire.write(0xE1);
    Wire.write(0x08);
    Wire.write(0x00);
    if (Wire.endTransmission() == 0) {
        aht_ok = true;
        delay(20);
    }
    Serial.println(aht_ok ? "TEMP: AHT10 OK" : "TEMP: AHT10 init failed");
}

bool temp_read(float* temp_c, float* humidity) {
    if (!aht_ok) return false;

    // Trigger measurement: 0xAC, 0x33, 0x00
    Wire.beginTransmission(ADDR_AHT10);
    Wire.write(0xAC);
    Wire.write(0x33);
    Wire.write(0x00);
    if (Wire.endTransmission() != 0) return false;

    delay(80);

    Wire.requestFrom((uint8_t)ADDR_AHT10, (uint8_t)6);
    if (Wire.available() < 6) return false;

    uint8_t data[6];
    for (int i = 0; i < 6; i++) data[i] = Wire.read();

    // Status byte check: bit 7 = busy
    if (data[0] & 0x80) return false;

    // Parse humidity (20-bit) and temperature (20-bit)
    uint32_t raw_hum = ((uint32_t)(data[1]) << 12) |
                       ((uint32_t)(data[2]) << 4) |
                       ((data[3] >> 4) & 0x0F);
    uint32_t raw_tmp = (((uint32_t)(data[3] & 0x0F)) << 16) |
                       ((uint32_t)(data[4]) << 8) |
                       (uint32_t)(data[5]);

    *humidity = (float)raw_hum / 1048576.0f * 100.0f;
    *temp_c   = (float)raw_tmp / 1048576.0f * 200.0f - 50.0f;
    return true;
}
