// record_audio.ino
// Streams 16 kHz mono 16-bit audio from the built-in PDM microphone over USB serial.
// Works on Nano 33 BLE Sense Rev1 and Rev2 (both use the same PDM library).
//
// Protocol (driven by tools/record_board.py):
//   PC sends 'R'  -> board replies "PNEU" then streams raw little-endian int16 samples
//   PC sends 'S'  -> board stops streaming
//   PC sends 'G' followed by one byte -> set microphone gain (0-80)
#include <PDM.h>

#define SAMPLE_RATE 16000
#define BUF_SAMPLES 512

static int16_t pdm_buf[BUF_SAMPLES];
static volatile int pdm_count = 0;
static bool streaming = false;
static int gain = 20;

void onPDMdata() {
  int bytes = PDM.available();
  PDM.read(pdm_buf, bytes);
  pdm_count = bytes / 2;
}

void setup() {
  Serial.begin(115200);              // USB CDC: baud is ignored, runs at full USB speed
  while (!Serial);
  pinMode(LED_BUILTIN, OUTPUT);
  PDM.onReceive(onPDMdata);
  PDM.setBufferSize(BUF_SAMPLES * 2);
  if (!PDM.begin(1, SAMPLE_RATE)) {
    Serial.println("ERR: PDM microphone failed to start");
    while (1);
  }
  PDM.setGain(gain);
  Serial.println("READY record_audio 16000Hz int16 mono");
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'R') {
      noInterrupts(); pdm_count = 0; interrupts();
      Serial.write("PNEU", 4);
      streaming = true;
      digitalWrite(LED_BUILTIN, HIGH);
    } else if (c == 'S') {
      streaming = false;
      digitalWrite(LED_BUILTIN, LOW);
    } else if (c == 'G') {
      while (!Serial.available());
      gain = constrain((uint8_t)Serial.read(), 0, 80);
      PDM.setGain(gain);
    }
  }

  if (pdm_count > 0) {
    int16_t out[BUF_SAMPLES];
    noInterrupts();
    int n = pdm_count;
    memcpy(out, pdm_buf, n * 2);
    pdm_count = 0;
    interrupts();
    if (streaming) Serial.write((uint8_t*)out, n * 2);
  }
}
