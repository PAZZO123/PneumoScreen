// breath.cpp – PneumoScreen non-blocking accelerometer breath rate
// Phase 4a fixes: higher MIN_STD_G, reject LAG_MIN edge, MIN_QUALITY 0.5,
// clear buffer on excessive movement.
#include "breath.h"
#include <Arduino.h>
#include <Arduino_BMI270_BMM150.h>
// Rev2 only — LSM9DS1 (Rev1) library not installed

// ── Constants ───────────────────────────────────────────────
#define TAU_BASELINE  4.0f
#define TAU_SMOOTH    0.15f
#define FS            10
#define BUF_N         150     // 15 s
#define MIN_FILL      100     // 10 s
#define LAG_MIN       6       // 100 /min max
#define LAG_MAX       60      // 10 /min min
#define MIN_STD_G     0.0012f // Phase 4a: raised from 0.0008
#define MAX_STD_G     0.06f
#define MIN_QUALITY   0.50f   // Phase 4a: raised from 0.35
#define N_MEDIAN      5

struct AgeGroup { const char* name; int fastFrom; };
static const AgeGroup AGES[] = {
    {"under 2 months", 60},
    {"2 to 12 months", 50},
    {"1 to 5 years",   40},
    {"adult",          21},
};

// ── State ───────────────────────────────────────────────────
static int ageIdx = 2;
static bool useBMI = false;
static float baseline[3], smooth_val[3];
static float buf[BUF_N][3];
static int bufHead = 0, bufFill = 0;
static float dir[3] = {1, 0, 0};
static float est[N_MEDIAN];
static int nEst = 0;
static unsigned long nextSampleUs = 0;
static unsigned long startMs = 0;
static bool primed = false;
static bool ready = false;
static int current_bpm = 0;
static float current_quality = 0;
static float current_sd = 0;
static const char* current_status = "Measuring...";
static unsigned long lastAnalysis = 0;

// ── IMU abstraction ─────────────────────────────────────────
static bool imuBegin() {
    if (IMU_BMI270_BMM150.begin()) { useBMI = true; return true; }
    return false;
}

static bool imuRead(float& x, float& y, float& z) {
    if (!IMU_BMI270_BMM150.accelerationAvailable()) return false;
    IMU_BMI270_BMM150.readAcceleration(x, y, z);
    return true;
}

// ── Signal processing ───────────────────────────────────────
static float sampleAt(int i, int k) {
    int start = (bufHead - bufFill + BUF_N) % BUF_N;
    return buf[(start + i) % BUF_N][k];
}

static float project(float* x, int n) {
    float mean[3] = {0}, cov[3][3] = {{0}};
    for (int i = 0; i < n; i++)
        for (int k = 0; k < 3; k++) mean[k] += sampleAt(i, k) / n;
    for (int i = 0; i < n; i++) {
        float d[3];
        for (int k = 0; k < 3; k++) d[k] = sampleAt(i, k) - mean[k];
        for (int a = 0; a < 3; a++)
            for (int b = 0; b < 3; b++) cov[a][b] += d[a] * d[b] / n;
    }
    for (int it = 0; it < 8; it++) {
        float v[3];
        for (int a = 0; a < 3; a++)
            v[a] = cov[a][0]*dir[0] + cov[a][1]*dir[1] + cov[a][2]*dir[2];
        float len = sqrtf(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
        if (len < 1e-12f) break;
        for (int a = 0; a < 3; a++) dir[a] = v[a] / len;
    }
    float var = 0;
    for (int i = 0; i < n; i++) {
        x[i] = 0;
        for (int k = 0; k < 3; k++)
            x[i] += (sampleAt(i, k) - mean[k]) * dir[k];
        var += x[i] * x[i] / n;
    }
    return sqrtf(var);
}

static float acorr(const float* x, int n, int lag, float var) {
    float s = 0;
    for (int i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
    return s / ((n - lag) * var);
}

static float breathPeriod(const float* x, int n, float sd, float& quality) {
    float var = sd * sd;
    float r[LAG_MAX + 2];
    int maxLag = min(LAG_MAX + 1, n / 2);
    for (int k = LAG_MIN - 1; k <= maxLag; k++)
        r[k] = acorr(x, n, k, var);

    int best = -1;
    // Phase 4a: skip LAG_MIN edge — start search at LAG_MIN+1
    for (int k = LAG_MIN + 1; k < maxLag; k++)
        if (r[k] > r[k-1] && r[k] >= r[k+1] && (best < 0 || r[k] > r[best]))
            best = k;
    if (best < 0) { quality = 0; return -1; }

    for (int div = 3; div >= 2; div--) {
        int k = (best + div/2) / div;
        for (int j = max(LAG_MIN, k-1); j <= min(maxLag-1, k+1); j++)
            if (r[j] > r[j-1] && r[j] >= r[j+1] && r[j] >= 0.8f * r[best])
                { best = j; div = 0; break; }
    }
    quality = r[best];
    float den = r[best-1] - 2*r[best] + r[best+1];
    float off = fabsf(den) > 1e-6f ? 0.5f*(r[best-1]-r[best+1])/den : 0;
    return best + constrain(off, -0.5f, 0.5f);
}

static float median_f(float* v, int n) {
    float t[N_MEDIAN];
    memcpy(t, v, n * sizeof(float));
    for (int i = 1; i < n; i++)
        for (int j = i; j > 0 && t[j] < t[j-1]; j--)
            { float s = t[j]; t[j] = t[j-1]; t[j-1] = s; }
    return n % 2 ? t[n/2] : 0.5f*(t[n/2-1]+t[n/2]);
}

static void analyse() {
    static float x[BUF_N];
    const AgeGroup& g = AGES[ageIdx];

    if (bufFill < MIN_FILL) {
        current_status = "Measuring...";
        current_bpm = 0;
        return;
    }

    float sd = project(x, bufFill);
    current_sd = sd;

    if (sd >= MAX_STD_G) {
        current_status = "Keep still";
        // Phase 4a: clear buffer on movement
        bufFill = 0;
        nEst = 0;
        current_bpm = 0;
        return;
    }
    if (sd <= MIN_STD_G) {
        current_status = "No signal";
        nEst = 0;
        current_bpm = 0;
        return;
    }

    float quality;
    float period = breathPeriod(x, bufFill, sd, quality);
    current_quality = quality;

    if (period > 0 && quality >= MIN_QUALITY) {
        if (nEst == N_MEDIAN) { memmove(est, est+1, sizeof(float)*(N_MEDIAN-1)); nEst--; }
        est[nEst++] = 60.0f * FS / period;
    }

    if (nEst >= 3) {
        float bpm = median_f(est, nEst);
        current_bpm = (int)(bpm + 0.5f);
        ready = true;
        if (bpm >= g.fastFrom) {
            current_status = "FAST BREATHING";
        } else {
            current_status = "Normal";
        }
        Serial.print("CSV:BREATH,");
        Serial.print(millis());
        Serial.print(',');
        Serial.print(current_bpm);
        Serial.print(',');
        Serial.println(bpm >= g.fastFrom ? "FAST" : "OK");
    } else {
        current_status = "Measuring...";
        current_bpm = 0;
    }
}

// ── Public API ──────────────────────────────────────────────

void breath_start() {
    ready = false;
    current_bpm = 0;
    current_quality = 0;
    current_sd = 0;
    current_status = "Measuring...";
    nEst = 0;
    bufHead = 0;
    bufFill = 0;
    primed = false;
    dir[0] = 1; dir[1] = 0; dir[2] = 0;

    if (!imuBegin()) {
        Serial.println("BREATH: ERR IMU not found");
        current_status = "IMU error";
        return;
    }
    Serial.println(useBMI ? "BREATH: BMI270" : "BREATH: LSM9DS1");
    startMs = millis();
    lastAnalysis = millis();
    Serial.println("BREATH: started");
}

void breath_update() {
    float a[3];
    if (!imuRead(a[0], a[1], a[2])) return;

    static unsigned long lastUs = micros();
    unsigned long nowUs = micros();
    float dt = (nowUs - lastUs) / 1e6f;
    lastUs = nowUs;
    if (dt <= 0 || dt > 0.2f) dt = 0.01f;

    if (!primed) {
        for (int i = 0; i < 3; i++) baseline[i] = smooth_val[i] = a[i];
        primed = true;
        nextSampleUs = nowUs;
    }

    for (int i = 0; i < 3; i++) {
        baseline[i]  += (a[i] - baseline[i])  * (dt / TAU_BASELINE);
        smooth_val[i] += (a[i] - smooth_val[i]) * (dt / TAU_SMOOTH);
    }

    if ((long)(nowUs - nextSampleUs) >= 0) {
        nextSampleUs += 1000000UL / FS;
        if (millis() - startMs > 3000) {
            for (int k = 0; k < 3; k++)
                buf[bufHead][k] = smooth_val[k] - baseline[k];
            bufHead = (bufHead + 1) % BUF_N;
            if (bufFill < BUF_N) bufFill++;
        }
    }

    // Analyse once per second
    if (millis() - lastAnalysis >= 1000) {
        lastAnalysis = millis();
        analyse();
    }
}

bool breath_ready()     { return ready; }
int  breath_bpm()       { return current_bpm; }
float breath_quality()  { return current_quality; }
float breath_signal_mg(){ return current_sd * 1000.0f; }
const char* breath_status() { return current_status; }

void breath_stop() {
    // IMU libraries don't have an explicit stop
    Serial.println("BREATH: stopped");
}

void breath_set_age(int idx) {
    if (idx >= 0 && idx < 4) ageIdx = idx;
}
int breath_get_age() { return ageIdx; }
