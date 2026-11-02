// gateway.h – BLE sensor gateway: record one step on request, send it as numbered frames.
// Protocol: docs/BLE_PROTOCOL.md, constants in ble_protocol.h.
#pragma once
#include <stdint.h>

bool gateway_init();     // BLE service + advertising, sensor probes
void gateway_update();   // call every loop()

// Same command bytes as the BLE control characteristic (also used by serial debug).
void gateway_command(const uint8_t* cmd, int len);

// Serial debug: print status, or dump the held step as "F:<hex>" frame lines.
void gateway_print_status();
void gateway_dump_serial();

bool gateway_connected();
uint8_t gateway_state();
uint8_t gateway_step();
uint8_t gateway_progress();
