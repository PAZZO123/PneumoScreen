// temp.cpp – AHT10 temperature/humidity via direct I2C
#include "temp.h"
#include "hw.h"
#include <Arduino.h>
#include <Wire.h>

static bool aht_ok = false;

static int aht_status() {
    if (Wire.requestFrom((uint8_t)ADDR_AHT10, (uint8_t)1) != 1) return -1;
    return Wire.read();
}

// AHT10 calibrates with 0xE1, AHT20/AHT21 (often sold as "AHT10") with 0xBE.
// Either way, a status byte with bit 3 set means it is already calibrated.
static bool aht_do_init() {
    int st = aht_status();
    if (st < 0) return false;
    if (st & 0x08) return true;
    const uint8_t cmds[] = {0xE1, 0xBE};
    for (uint8_t cmd : cmds) {
        Wire.beginTransmission(ADDR_AHT10);
        Wire.write(cmd);
        Wire.write(0x08);
        Wire.write(0x00);
        Wire.endTransmission();
        delay(20);
        st = aht_status();
        if (st >= 0 && (st & 0x08)) return true;
    }
    Serial.print("TEMP: calibration failed, status=0x");
    Serial.println(st, HEX);
    return false;
}

void temp_init() {
    if (!temp_present) {
        Serial.println("TEMP: not found");
        return;
    }
    aht_ok = aht_do_init();
    Serial.println(aht_ok ? "TEMP: AHT10 OK" : "TEMP: AHT10 init failed");
}

bool temp_service() {
    static unsigned long last_check_ms = 0;
    if (millis() - last_check_ms < 1000) return false;
    last_check_ms = millis();

    bool present = hw_probe(ADDR_AHT10);
    if (aht_ok) {
        if (!present) {
            aht_ok = false;
            temp_present = false;
            Serial.println("TEMP: lost");
        }
        return false;
    } else {
        if (present) {
            if (aht_do_init()) {
                aht_ok = true;
                temp_present = true;
                Serial.println("TEMP: reconnected");
                return true;
            }
        }
        return false;
    }
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
