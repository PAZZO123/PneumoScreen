// hw.h – PneumoScreen hardware abstraction: I2C bus check, device probing
#pragma once
#include <stdint.h>

// Pin definitions
#define RED_LED_PIN   11
#define GREEN_LED_PIN 12
#define BUTTON_PIN    13
#define XCLK_PIN       9

// I2C addresses
#define ADDR_OLED    0x3C
#define ADDR_MAX30102 0x57
#define ADDR_OV7670  0x21
#define ADDR_AHT10   0x38

// Device-present flags (set by hw_init)
extern bool oled_present;
extern bool spo2_present;
extern bool cam_present;
extern bool temp_present;

// Initialise hardware: check I2C bus, probe devices.
// Returns true if the bus is OK (even if no devices found).
// Returns false if the bus is stuck (A4/A5 held LOW).
bool hw_init();

// Read the shield button (D13). Returns true when pressed.
bool hw_button();

// Debounced button: returns true on the falling edge (press).
bool hw_button_pressed();

// Blink the red LED fast (I2C error pattern). Blocks.
void hw_error_blink();

// Set LEDs: 0=off, 1=red, 2=green
void hw_led(int colour);
