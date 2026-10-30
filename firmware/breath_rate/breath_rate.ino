// breath_rate.ino  -  PneumoScreen single-sensor demo
// Measures breathing rate with the built-in accelerometer resting on the chest and flags
// fast breathing using the WHO IMCI age thresholds for pneumonia.
// Works on Nano 33 BLE Sense Rev1 (LSM9DS1) and Rev2 (BMI270); the chip is detected at startup.
//
// Method: the three axes are high-pass filtered, projected onto their main direction of movement,
// and the breathing period is the strongest autocorrelation lag over the last 15 s.
//
// Serial Monitor (115200): type 1-4 to choose the age group, 'p' = Serial Plotter output,
// 'r' = raw accelerometer stream (for recording test data).
// Built-in RGB LED: blue = measuring / no signal, green = normal, red = fast breathing.
#include <Arduino_BMI270_BMM150.h>
#include <Arduino_LSM9DS1.h>

// ── Signal processing ─────────────────────────────────────────
#define TAU_BASELINE  4.0f    // s, removes gravity and slow posture changes
#define TAU_SMOOTH    0.15f   // s, removes vibration / tremor
#define FS            10      // Hz, analysis rate after decimation
#define BUF_N         150     // 15 s analysis window
#define MIN_FILL      100     // need 10 s before the first estimate
#define LAG_MIN       6       // 0.6 s period -> 100 /min
#define LAG_MAX       60      // 6 s period   -> 10 /min
#define MIN_STD_G     0.0008f // below this the board is not moving with the chest
#define MAX_STD_G     0.06f   // above this the patient/board is moving too much
#define MIN_QUALITY   0.35f   // autocorrelation peak needed to trust the rhythm
#define N_MEDIAN      5       // displayed rate = median of the last 5 estimates

struct AgeGroup { const char* name; int fastFrom; };
const AgeGroup AGES[] = {
  {"under 2 months",   60},
  {"2 to 12 months",   50},
  {"1 to 5 years",     40},
  {"adult",            21},   // adult tachypnea: more than 20 /min
};
int ageIdx = 2;

bool useBMI = false;
float baseline[3], smooth[3];
float buf[BUF_N][3]; int bufHead = 0, bufFill = 0;
float dir[3] = {1, 0, 0};                 // main movement direction (unit vector)
float est[N_MEDIAN]; int nEst = 0;
unsigned long nextSampleUs = 0, lastReport = 0, startMs = 0;
bool primed = false;
char mode = 0;                            // 0 = text, 'p' = plotter, 'r' = raw

bool imuBegin() {
  if (IMU_BMI270_BMM150.begin()) { useBMI = true;  return true; }
  if (IMU_LSM9DS1.begin())       { useBMI = false; return true; }
  return false;
}
bool imuRead(float& x, float& y, float& z) {
  if (useBMI) { if (!IMU_BMI270_BMM150.accelerationAvailable()) return false; IMU_BMI270_BMM150.readAcceleration(x, y, z); }
  else        { if (!IMU_LSM9DS1.accelerationAvailable())       return false; IMU_LSM9DS1.readAcceleration(x, y, z); }
  return true;
}

void led(bool r, bool g, bool b) {      // RGB LED is active LOW
  digitalWrite(LEDR, !r); digitalWrite(LEDG, !g); digitalWrite(LEDB, !b);
}

void printAges() {
  Serial.println(useBMI ? "Board: Nano 33 BLE Sense Rev2 (BMI270)" : "Board: Nano 33 BLE Sense Rev1 (LSM9DS1)");
  Serial.println("Age group (type number):");
  for (int i = 0; i < 4; i++)
    Serial.print(String("  ") + (i + 1) + " = " + AGES[i].name + " (fast if >= " + AGES[i].fastFrom + "/min)\n");
  Serial.println(String("Selected: ") + AGES[ageIdx].name);
}

void setup() {
  Serial.begin(115200);
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 4000);
  pinMode(LEDR, OUTPUT); pinMode(LEDG, OUTPUT); pinMode(LEDB, OUTPUT);
  led(0, 0, 1);

  Serial.println("\n=== PneumoScreen - Breathing Rate (accelerometer) ===");
  if (!imuBegin()) { Serial.println("ERROR: accelerometer not found"); led(1, 0, 0); while (1); }
  printAges();
  Serial.println("Lie back, place the board flat on the chest or upper belly, keep still, breathe normally.\n");
  startMs = millis();
}

float sampleAt(int i, int k) {            // i-th oldest sample in the window, axis k
  int start = (bufHead - bufFill + BUF_N) % BUF_N;
  return buf[(start + i) % BUF_N][k];
}

// Projects the window onto its main movement direction. Returns the std of the projection (g).
float project(float* x, int n) {
  float mean[3] = {0, 0, 0}, cov[3][3] = {{0}};
  for (int i = 0; i < n; i++) for (int k = 0; k < 3; k++) mean[k] += sampleAt(i, k) / n;
  for (int i = 0; i < n; i++) {
    float d[3]; for (int k = 0; k < 3; k++) d[k] = sampleAt(i, k) - mean[k];
    for (int a = 0; a < 3; a++) for (int b = 0; b < 3; b++) cov[a][b] += d[a] * d[b] / n;
  }
  for (int it = 0; it < 8; it++) {        // power iteration, warm-started from last direction
    float v[3];
    for (int a = 0; a < 3; a++) v[a] = cov[a][0] * dir[0] + cov[a][1] * dir[1] + cov[a][2] * dir[2];
    float len = sqrtf(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if (len < 1e-12f) break;
    for (int a = 0; a < 3; a++) dir[a] = v[a] / len;
  }
  float var = 0;
  for (int i = 0; i < n; i++) {
    x[i] = 0; for (int k = 0; k < 3; k++) x[i] += (sampleAt(i, k) - mean[k]) * dir[k];
    var += x[i] * x[i] / n;
  }
  return sqrtf(var);
}

float acorr(const float* x, int n, int lag, float var) {
  float s = 0;
  for (int i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
  return s / ((n - lag) * var);
}

// Breathing period in samples from the autocorrelation; quality = peak height (0..1)
float breathPeriod(const float* x, int n, float sd, float& quality) {
  float var = sd * sd, r[LAG_MAX + 2];
  int maxLag = min(LAG_MAX + 1, n / 2);
  for (int k = LAG_MIN - 1; k <= maxLag; k++) r[k] = acorr(x, n, k, var);
  int best = -1;
  for (int k = LAG_MIN; k < maxLag; k++)
    if (r[k] > r[k - 1] && r[k] >= r[k + 1] && (best < 0 || r[k] > r[best])) best = k;
  if (best < 0) { quality = 0; return -1; }
  for (int div = 3; div >= 2; div--) {    // prefer the fundamental over a 2x / 3x multiple
    int k = (best + div / 2) / div;
    for (int j = max(LAG_MIN, k - 1); j <= min(maxLag - 1, k + 1); j++)
      if (r[j] > r[j - 1] && r[j] >= r[j + 1] && r[j] >= 0.8f * r[best]) { best = j; div = 0; break; }
  }
  quality = r[best];
  float den = r[best - 1] - 2 * r[best] + r[best + 1];   // parabolic refinement
  float off = fabsf(den) > 1e-6f ? 0.5f * (r[best - 1] - r[best + 1]) / den : 0;
  return best + constrain(off, -0.5f, 0.5f);
}

float median(float* v, int n) {
  float t[N_MEDIAN]; memcpy(t, v, n * sizeof(float));
  for (int i = 1; i < n; i++) for (int j = i; j > 0 && t[j] < t[j - 1]; j--) { float s = t[j]; t[j] = t[j - 1]; t[j - 1] = s; }
  return n % 2 ? t[n / 2] : 0.5f * (t[n / 2 - 1] + t[n / 2]);
}

void report(unsigned long now) {
  static float x[BUF_N];
  const AgeGroup& g = AGES[ageIdx];
  float bpm = -1, quality = 0, sd = 0;
  String status;

  if (bufFill < MIN_FILL) { status = "Measuring..."; led(0, 0, 1); }
  else {
    sd = project(x, bufFill);
    if (sd >= MAX_STD_G)      { status = "Too much movement - keep still"; nEst = 0; led(0, 0, 1); }
    else if (sd <= MIN_STD_G) { status = "No breathing detected - check board placement"; nEst = 0; led(0, 0, 1); }
    else {
      float period = breathPeriod(x, bufFill, sd, quality);
      if (period > 0 && quality >= MIN_QUALITY) {
        if (nEst == N_MEDIAN) { memmove(est, est + 1, sizeof(float) * (N_MEDIAN - 1)); nEst--; }
        est[nEst++] = 60.0f * FS / period;
      }
      if (nEst >= 3) {
        bpm = median(est, nEst);
        if (bpm >= g.fastFrom) { status = "FAST BREATHING - possible pneumonia, refer"; led(1, 0, 0); }
        else                   { status = "Normal breathing rate"; led(0, 1, 0); }
      } else { status = "Measuring... (irregular signal, keep still)"; led(0, 0, 1); }
    }
  }

  if (mode) return;
  Serial.print("t="); Serial.print((now - startMs) / 1000); Serial.print("s  Breathing rate: ");
  if (bpm < 0) Serial.print("--"); else Serial.print((int)(bpm + 0.5f));
  Serial.print(" /min  ["); Serial.print(g.name); Serial.print(", fast >= "); Serial.print(g.fastFrom);
  Serial.print("]  "); Serial.print(status);
  Serial.print("  (signal "); Serial.print(sd * 1000, 1); Serial.print(" mg, rhythm "); Serial.print(quality, 2); Serial.println(")");
  Serial.print("CSV:"); Serial.print(now); Serial.print(','); Serial.print(bpm < 0 ? 0 : (int)(bpm + 0.5f));
  Serial.print(','); Serial.println(bpm >= g.fastFrom ? "FAST" : "OK");
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c >= '1' && c <= '4') { ageIdx = c - '1'; nEst = 0; Serial.println(); printAges(); }
    if (c == 'p' || c == 'r') mode = (mode == c) ? 0 : c;
  }

  float a[3];
  if (!imuRead(a[0], a[1], a[2])) return;
  static unsigned long lastUs = micros();
  unsigned long nowUs = micros();
  float dt = (nowUs - lastUs) / 1e6f; lastUs = nowUs;
  if (dt <= 0 || dt > 0.2f) dt = 0.01f;

  if (mode == 'r') {                                   // raw stream at full sensor rate
    Serial.print(millis()); for (int k = 0; k < 3; k++) { Serial.print(','); Serial.print(a[k], 5); } Serial.println();
  }
  if (!primed) { for (int i = 0; i < 3; i++) baseline[i] = smooth[i] = a[i]; primed = true; nextSampleUs = nowUs; }
  for (int i = 0; i < 3; i++) {
    baseline[i] += (a[i] - baseline[i]) * (dt / TAU_BASELINE);
    smooth[i]   += (a[i] - smooth[i])   * (dt / TAU_SMOOTH);
  }

  if ((long)(nowUs - nextSampleUs) >= 0) {            // decimate to FS
    nextSampleUs += 1000000UL / FS;
    if (millis() - startMs > 3000) {                    // let the filters settle first
      for (int k = 0; k < 3; k++) buf[bufHead][k] = smooth[k] - baseline[k];
      bufHead = (bufHead + 1) % BUF_N;
      if (bufFill < BUF_N) bufFill++;
    }
    if (mode == 'p') {
      float x = 0; for (int k = 0; k < 3; k++) x += (smooth[k] - baseline[k]) * dir[k];
      Serial.println(x * 1000, 3);
    }
  }

  unsigned long now = millis();
  if (now - lastReport >= 1000) { lastReport = now; report(now); }
}
