// hw_test.ino
// Hardware check for PneumoScreen: blinks LEDs on D11/D12, reads the
// TinyML Shield button on D13, and runs an I2C scan on command.
//
// Serial commands:
//   'I' -> run I2C scan on A4/A5
//   'P' -> read raw pin state of A4 and A5 (debug wiring)
//
// Expected I2C addresses (when wired):
//   0x21  OV7670 camera (via TinyML Shield)
//   0x3C  SSD1306 OLED
//   0x57  MAX30102 pulse oximeter
#include <Wire.h>

#define RED_LED_PIN   11
#define GREEN_LED_PIN 12
#define BUTTON_PIN    13   // TinyML Shield onboard button (INPUT_PULLUP, LOW when pressed)

static bool wire_started = false;

void do_i2c_scan() {
  if (!wire_started) {
    Wire.begin();
    wire_started = true;
  }
  Serial.println("I2C scan on A4/A5:");
  int found = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    uint8_t err = Wire.endTransmission();
    if (err == 0) {
      Serial.print("  0x");
      if (addr < 16) Serial.print('0');
      Serial.print(addr, HEX);
      if      (addr == 0x21) Serial.print("  OV7670 camera");
      else if (addr == 0x3C) Serial.print("  SSD1306 OLED");
      else if (addr == 0x57) Serial.print("  MAX30102 pulse-ox");
      else if (addr == 0x5A) Serial.print("  MLX90614 temp");
      Serial.println();
      found++;
    }
  }
  if (found == 0) Serial.println("  (none found)");
  Serial.print("Total: ");
  Serial.println(found);
}

void setup() {
  Serial.begin(115200);
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 3000);

  pinMode(RED_LED_PIN, OUTPUT);
  pinMode(GREEN_LED_PIN, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  // Turn off the built-in RGB LED (active LOW on Nano 33 BLE)
  pinMode(LEDR, OUTPUT); digitalWrite(LEDR, HIGH);
  pinMode(LEDG, OUTPUT); digitalWrite(LEDG, HIGH);
  pinMode(LEDB, OUTPUT); digitalWrite(LEDB, HIGH);

  Serial.println("=== PneumoScreen Hardware Test ===");
  Serial.println("Red LED   = D11");
  Serial.println("Green LED = D12");
  Serial.println("Button    = D13 (Shield, INPUT_PULLUP)");
  Serial.println("Commands: I=I2C scan, P=pin state");
  Serial.println("Starting LED blink...");
}

static bool lastButton = HIGH;

void loop() {
  // Alternate red and green LEDs
  digitalWrite(RED_LED_PIN, HIGH);
  digitalWrite(GREEN_LED_PIN, LOW);
  digitalWrite(LEDR, LOW);
  digitalWrite(LEDG, HIGH);
  delay(500);

  digitalWrite(RED_LED_PIN, LOW);
  digitalWrite(GREEN_LED_PIN, HIGH);
  digitalWrite(LEDR, HIGH);
  digitalWrite(LEDG, LOW);
  delay(500);

  // Button (active LOW)
  bool btn = digitalRead(BUTTON_PIN);
  if (btn != lastButton) {
    Serial.print("Button D13: ");
    Serial.println(btn == LOW ? "PRESSED" : "RELEASED");
    lastButton = btn;
  }

  // Serial commands
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'I' || c == 'i') {
      do_i2c_scan();
    } else if (c == 'P' || c == 'p') {
      // Read raw pin state to debug wiring
      if (wire_started) {
        Wire.end();
        wire_started = false;
      }
      pinMode(A4, INPUT);
      pinMode(A5, INPUT);
      delay(10);
      Serial.print("Pin A4(SDA)=");
      Serial.print(digitalRead(A4) ? "HIGH" : "LOW");
      Serial.print("  A5(SCL)=");
      Serial.println(digitalRead(A5) ? "HIGH" : "LOW");
    }
  }
}
