// gateway.cpp – PneumoScreen BLE sensor gateway (protocol v1)
#include "gateway.h"
#include "ble_protocol.h"
#include "audio.h"
#include "breath.h"
#include "temp.h"
#include "hw.h"
#include "ui.h"
#include <Arduino.h>
#include <ArduinoBLE.h>
#include <Arduino_BMI270_BMM150.h>
#include "utility/ATT.h"

// ── BLE objects ─────────────────────────────────────────────
static BLEService svc(PS_UUID_SERVICE);
static BLECharacteristic chCtrl(PS_UUID_CONTROL, BLEWrite | BLEWriteWithoutResponse, 8);
static BLECharacteristic chStatus(PS_UUID_STATUS, BLERead | BLENotify, PS_STATUS_SIZE, true);
static BLECharacteristic chData(PS_UUID_DATA, BLENotify, 244);
static BLECharacteristic chLevel(PS_UUID_LEVEL, BLENotify, 3, true);

#define PAYLOAD_CAP   240
#define FRAMES_PER_LOOP 6
#define MAX_RESEND    8

// ── step state ──────────────────────────────────────────────
struct Seg { uint8_t kind; uint8_t* p; uint32_t len; };

static uint8_t state = PS_STATE_IDLE, step = PS_STEP_NONE, err = PS_ERR_NONE, progress = 0;
static uint8_t flags = 0;
static uint32_t ping_token = 0;
static bool status_dirty = true;
static unsigned long last_status_ms = 0;

static uint8_t* stepbuf = nullptr;        // one heap block per step
static Seg segs[3];
static int nsegs = 0;
static uint16_t seconds = 0;
static unsigned long rec_start_ms = 0;
static uint32_t breath_bytes = 0, breath_cap = 0;

static uint16_t pm = 0;                   // payload bytes per frame, fixed per transfer
static uint16_t total_frames = 0;
static uint32_t payload_bytes = 0, crc = 0;
static uint16_t next_seq = 0;             // sequential send cursor (0..total_frames incl. END)
static uint16_t rs_from[MAX_RESEND], rs_to[MAX_RESEND];
static int n_resend = 0;

static bool is_audio_step(uint8_t s) { return s >= PS_STEP_LUNG_RU && s <= PS_STEP_LUNG_LL; }

// ── helpers ─────────────────────────────────────────────────
static uint32_t crc32_update(uint32_t c, const uint8_t* d, uint32_t n) {
    c = ~c;
    for (uint32_t i = 0; i < n; i++) {
        c ^= d[i];
        for (int k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
        if ((i & 0x3FFF) == 0) hw_wdt_kick();
    }
    return ~c;
}

static uint16_t current_mtu() {
    for (uint16_t h = 0; h < 32; h++)
        if (ATT.connected(h)) return ATT.mtu(h);
    return 23;
}

static uint16_t payload_for_mtu(uint16_t mtu) {
    int p = (int)mtu - 3 - PS_FRAME_HEADER;
    if (p > PAYLOAD_CAP) p = PAYLOAD_CAP;
    if (p < 16) p = 16;
    return (uint16_t)(p & ~1);
}

static void set_state(uint8_t s) { if (state != s) { state = s; status_dirty = true; } }
static void fail(uint8_t e) {
    static const char* NAMES[] = {"none", "bad command", "no sensor", "no memory", "busy", "too long"};
    err = e;
    status_dirty = true;
    Serial.print("GW: ERR "); Serial.println(e < 6 ? NAMES[e] : "?");
}

static void free_step() {
    audio_stop();
    if (stepbuf) { free(stepbuf); stepbuf = nullptr; }
    nsegs = 0; total_frames = 0; payload_bytes = 0; n_resend = 0; next_seq = 0;
}

static void put16(uint8_t* b, uint16_t v) { b[0] = v; b[1] = v >> 8; }
static void put32(uint8_t* b, uint32_t v) { b[0] = v; b[1] = v >> 8; b[2] = v >> 16; b[3] = v >> 24; }

static void build_status(uint8_t* b) {
    memset(b, 0, PS_STATUS_SIZE);
    b[0] = PS_PROTO_VERSION; b[1] = PS_FW_MAJOR; b[2] = PS_FW_MINOR;
    b[3] = flags; b[4] = state; b[5] = step; b[6] = progress; b[7] = err;
    put16(b + 8, total_frames);
    put16(b + 10, pm ? pm : payload_for_mtu(current_mtu()));
    put32(b + 12, ping_token);
    put32(b + 16, millis() / 1000);
}

static void push_status() {
    flags &= ~(PS_FLAG_TEMP_OK | PS_FLAG_OLED_OK | PS_FLAG_SPO2_OK);   // external sensors hot-plug
    if (!safe_mode && temp_present) flags |= PS_FLAG_TEMP_OK;
    if (!safe_mode && ui_ok()) flags |= PS_FLAG_OLED_OK;
    if (!safe_mode && spo2_present) flags |= PS_FLAG_SPO2_OK;
    uint8_t b[PS_STATUS_SIZE];
    build_status(b);
    chStatus.writeValue(b, PS_STATUS_SIZE);
    status_dirty = false;
    last_status_ms = millis();
}

// Frame <seq> into buf; returns length. seq == total_frames is END.
static int build_frame(uint16_t seq, uint8_t* buf) {
    put16(buf, seq);
    buf[3] = step;
    if (seq == total_frames) {
        buf[2] = PS_KIND_END;
        put16(buf + 4, total_frames);
        put32(buf + 6, payload_bytes);
        put32(buf + 10, crc);
        return PS_FRAME_HEADER + 10;
    }
    uint16_t base = 0;
    for (int i = 0; i < nsegs; i++) {
        uint16_t nf = (segs[i].len + pm - 1) / pm;
        if (seq < base + nf) {
            uint32_t off = (uint32_t)(seq - base) * pm;
            uint32_t n = segs[i].len - off;
            if (n > pm) n = pm;
            buf[2] = segs[i].kind;
            memcpy(buf + PS_FRAME_HEADER, segs[i].p + off, n);
            return PS_FRAME_HEADER + n;
        }
        base += nf;
    }
    return 0;
}

static void begin_transfer() {
    pm = payload_for_mtu(current_mtu());
    total_frames = 0; payload_bytes = 0; crc = 0;
    for (int i = 0; i < nsegs; i++) {
        total_frames += (segs[i].len + pm - 1) / pm;
        payload_bytes += segs[i].len;
        crc = crc32_update(crc, segs[i].p, segs[i].len);
    }
    next_seq = 0;
    n_resend = 0;
    progress = 0;
    set_state(PS_STATE_TRANSFERRING);
    Serial.print("GW: transfer step "); Serial.print(step);
    Serial.print(" frames="); Serial.print(total_frames);
    Serial.print(" bytes="); Serial.print(payload_bytes);
    Serial.print(" payload="); Serial.println(pm);
}

// ── step start / finish ─────────────────────────────────────
static void start_step(uint8_t s, uint16_t secs) {
    free_step();
    err = PS_ERR_NONE;
    pm = 0;
    progress = 0;
    step = s;
    seconds = secs;

    if (is_audio_step(s)) {
        if (secs < 1 || secs > PS_MAX_AUDIO_SEC) { fail(PS_ERR_TOO_LONG); step = PS_STEP_NONE; return; }
        uint32_t n = (uint32_t)secs * PS_AUDIO_RATE;
        stepbuf = (uint8_t*)malloc(n * 2);
        if (!stepbuf) { fail(PS_ERR_NO_MEMORY); step = PS_STEP_NONE; return; }
        if (!audio_start((int16_t*)stepbuf, n)) {
            flags &= ~PS_FLAG_MIC_OK;
            free_step(); fail(PS_ERR_NO_SENSOR); step = PS_STEP_NONE; return;
        }
        flags |= PS_FLAG_MIC_OK;
    } else if (s == PS_STEP_BREATH) {
        if (secs < 5 || secs > PS_MAX_BREATH_SEC) { fail(PS_ERR_TOO_LONG); step = PS_STEP_NONE; return; }
        breath_cap = (uint32_t)secs * PS_ACCEL_RATE * 6;
        stepbuf = (uint8_t*)malloc(breath_cap + 2);
        if (!stepbuf) { fail(PS_ERR_NO_MEMORY); step = PS_STEP_NONE; return; }
        breath_bytes = 0;
        if (IMU_BMI270_BMM150.begin()) flags |= PS_FLAG_IMU_OK;   // re-checked every breath step
        else { flags &= ~PS_FLAG_IMU_OK; free_step(); fail(PS_ERR_NO_SENSOR); step = PS_STEP_NONE; return; }
        breath_start();
    } else if (s == PS_STEP_TEMP) {
        if (!(flags & PS_FLAG_TEMP_OK)) { fail(PS_ERR_NO_SENSOR); step = PS_STEP_NONE; return; }
        stepbuf = (uint8_t*)malloc(4);
        if (!stepbuf) { fail(PS_ERR_NO_MEMORY); step = PS_STEP_NONE; return; }
    } else if (s == PS_STEP_SPO2) {
        fail(PS_ERR_NO_SENSOR); step = PS_STEP_NONE; return;
    } else {
        fail(PS_ERR_BAD_CMD); step = PS_STEP_NONE; return;
    }
    rec_start_ms = millis();
    set_state(PS_STATE_RECORDING);
    status_dirty = true;
    Serial.print("GW: recording step "); Serial.print(s);
    Serial.print(" for "); Serial.print(secs); Serial.println(" s");
}

static void finish_recording() {
    nsegs = 0;
    if (is_audio_step(step)) {
        audio_stop();
        if (audio_overrun()) Serial.println("GW: WARN PDM overrun during recording");
        segs[nsegs++] = { PS_KIND_AUDIO, stepbuf, (uint32_t)audio_count() * 2 };
    } else if (step == PS_STEP_BREATH) {
        breath_stop();
        uint8_t* r = stepbuf + breath_cap;
        int bpm = breath_bpm();
        r[0] = (uint8_t)constrain(bpm, 0, 255);
        r[1] = (uint8_t)constrain((int)lroundf(breath_quality() * 100), 0, 100);
        if (breath_bytes) segs[nsegs++] = { PS_KIND_ACCEL, stepbuf, breath_bytes };
        segs[nsegs++] = { PS_KIND_BREATH, r, 2 };
    } else if (step == PS_STEP_TEMP) {
        float t = 0, h = 0;
        if (!temp_read(&t, &h)) { free_step(); fail(PS_ERR_NO_SENSOR); set_state(PS_STATE_IDLE); step = PS_STEP_NONE; return; }
        put16(stepbuf, (uint16_t)(int16_t)lroundf(t * 100));
        put16(stepbuf + 2, (uint16_t)constrain((long)lroundf(h * 100), 0L, 65535L));
        segs[nsegs++] = { PS_KIND_TEMP, stepbuf, 4 };
    }
    begin_transfer();
}

static void update_recording() {
    unsigned long el = millis() - rec_start_ms;
    uint8_t p = 0;
    if (is_audio_step(step)) {
        audio_update();
        float rms; bool clip;
        if (audio_level(&rms, &clip)) {
            uint8_t b[3];
            put16(b, (uint16_t)constrain((long)lroundf(rms * 10000), 0L, 65535L));
            b[2] = clip;
            chLevel.writeValue(b, 3);
        }
        p = (uint8_t)((uint32_t)audio_count() * 100 / ((uint32_t)seconds * PS_AUDIO_RATE));
        if (audio_full()) { progress = 100; finish_recording(); return; }
        if (el > (uint32_t)seconds * 1000 + 2000) { finish_recording(); return; }  // safety
    } else if (step == PS_STEP_BREATH) {
        breath_update();
        int16_t mg[3];
        if (breath_take_sample(mg) && breath_bytes + 6 <= breath_cap) {
            memcpy(stepbuf + breath_bytes, mg, 6);
            breath_bytes += 6;
        }
        p = (uint8_t)min(100UL, el * 100 / ((uint32_t)seconds * 1000));
        if (el >= (uint32_t)seconds * 1000) { progress = 100; finish_recording(); return; }
    } else if (step == PS_STEP_TEMP) {
        finish_recording();
        return;
    }
    if (p != progress) { progress = p; if (p % 5 == 0) status_dirty = true; }
}

static void update_transfer() {
    if (!BLE.connected()) { set_state(PS_STATE_HOLDING); return; }
    uint8_t buf[PS_FRAME_HEADER + PAYLOAD_CAP];
    for (int k = 0; k < FRAMES_PER_LOOP; k++) {
        uint16_t seq;
        if (next_seq <= total_frames) {
            seq = next_seq++;
        } else if (n_resend) {
            seq = rs_from[0];
            if (rs_from[0] >= rs_to[0]) {
                for (int i = 1; i < n_resend; i++) { rs_from[i - 1] = rs_from[i]; rs_to[i - 1] = rs_to[i]; }
                n_resend--;
            } else {
                rs_from[0]++;
            }
        } else {
            progress = 100;
            set_state(PS_STATE_HOLDING);
            return;
        }
        int len = build_frame(seq, buf);
        if (len) chData.writeValue(buf, len);
        if (next_seq <= total_frames) {
            uint8_t p = (uint8_t)((uint32_t)next_seq * 100 / (total_frames + 1));
            if (p != progress) { progress = p; if (p % 10 == 0) status_dirty = true; }
        }
    }
}

// ── commands ────────────────────────────────────────────────
void gateway_command(const uint8_t* c, int len) {
    if (len < 1) return;
    switch (c[0]) {
    case PS_OP_START_STEP:
        if (len < 4) { fail(PS_ERR_BAD_CMD); break; }
        start_step(c[1], (uint16_t)(c[2] | (c[3] << 8)));
        break;
    case PS_OP_STOP:
        if (state == PS_STATE_RECORDING) finish_recording();
        break;
    case PS_OP_RESEND: {
        if (len < 5 || !stepbuf || (state != PS_STATE_TRANSFERRING && state != PS_STATE_HOLDING)) { fail(PS_ERR_BAD_CMD); break; }
        uint16_t a = c[1] | (c[2] << 8), b = c[3] | (c[4] << 8);
        if (b > total_frames) b = total_frames;
        if (a > b || n_resend >= MAX_RESEND) { fail(PS_ERR_BUSY); break; }
        rs_from[n_resend] = a; rs_to[n_resend] = b; n_resend++;
        set_state(PS_STATE_TRANSFERRING);
        break;
    }
    case PS_OP_DONE_ACK:
        free_step();
        step = PS_STEP_NONE; progress = 0; pm = 0;
        set_state(PS_STATE_IDLE);
        break;
    case PS_OP_PING:
        if (len >= 5) ping_token = c[1] | (c[2] << 8) | ((uint32_t)c[3] << 16) | ((uint32_t)c[4] << 24);
        break;
    default:
        fail(PS_ERR_BAD_CMD);
    }
    status_dirty = true;
}

static void onCtrlWritten(BLEDevice, BLECharacteristic ch) {
    gateway_command(ch.value(), ch.valueLength());
}

static void onConnect(BLEDevice central) {
    Serial.print("GW: connected "); Serial.println(central.address());
    status_dirty = true;
}

static void onDisconnect(BLEDevice central) {
    Serial.print("GW: disconnected "); Serial.println(central.address());
    BLE.advertise();
}

// ── public ──────────────────────────────────────────────────
bool gateway_init() {
    flags = 0;
    if (safe_mode) flags |= PS_FLAG_SAFE_MODE;
    if (audio_probe()) flags |= PS_FLAG_MIC_OK;
    if (IMU_BMI270_BMM150.begin()) flags |= PS_FLAG_IMU_OK;
    if (!safe_mode && temp_present) flags |= PS_FLAG_TEMP_OK;
    if (!safe_mode && oled_present) flags |= PS_FLAG_OLED_OK;
    hw_wdt_kick();

    if (!BLE.begin()) { Serial.println("GW: ERR BLE.begin failed"); return false; }
    BLE.setLocalName(PS_DEVICE_NAME);
    BLE.setDeviceName(PS_DEVICE_NAME);
    BLE.setConnectionInterval(6, 24);   // 7.5–30 ms; the central decides
    BLE.setAdvertisedService(svc);
    svc.addCharacteristic(chCtrl);
    svc.addCharacteristic(chStatus);
    svc.addCharacteristic(chData);
    svc.addCharacteristic(chLevel);
    BLE.addService(svc);
    chCtrl.setEventHandler(BLEWritten, onCtrlWritten);
    BLE.setEventHandler(BLEConnected, onConnect);
    BLE.setEventHandler(BLEDisconnected, onDisconnect);
    uint8_t b[PS_STATUS_SIZE];
    build_status(b);
    chStatus.writeValue(b, PS_STATUS_SIZE);
    BLE.advertise();
    Serial.print("GW: advertising as "); Serial.print(PS_DEVICE_NAME);
    Serial.print(" flags=0x"); Serial.println(flags, HEX);
    return true;
}

// MAX30102 has no driver yet: track presence so the phone sees it come and go.
static void spo2_service() {
    static unsigned long last = 0;
    if (safe_mode || state == PS_STATE_RECORDING || millis() - last < 1000) return;
    last = millis();
    bool p = hw_probe(ADDR_MAX30102);
    if (p != spo2_present) {
        spo2_present = p;
        status_dirty = true;
        Serial.println(p ? "SPO2: connected" : "SPO2: lost");
    }
}

void gateway_update() {
    BLE.poll();
    spo2_service();
    if (state == PS_STATE_RECORDING) update_recording();
    else if (state == PS_STATE_TRANSFERRING) update_transfer();
    if (status_dirty || millis() - last_status_ms >= 1000) push_status();
}

bool gateway_connected() { return BLE.connected(); }
uint8_t gateway_state() { return state; }
uint8_t gateway_step() { return step; }
uint8_t gateway_progress() { return progress; }

void gateway_print_status() {
    Serial.print("STATUS: state="); Serial.print(state);
    Serial.print(" step="); Serial.print(step);
    Serial.print(" progress="); Serial.print(progress);
    Serial.print(" err="); Serial.print(err);
    Serial.print(" frames="); Serial.print(total_frames);
    Serial.print(" flags=0x"); Serial.print(flags, HEX);
    Serial.print(" ble="); Serial.println(BLE.connected() ? "connected" : "advertising");
}

void gateway_dump_serial() {
    if (!stepbuf || !nsegs || (state != PS_STATE_HOLDING && state != PS_STATE_TRANSFERRING)) {
        Serial.println("DUMP: nothing held");
        return;
    }
    uint8_t buf[PS_FRAME_HEADER + PAYLOAD_CAP];
    Serial.print("DUMP: begin "); Serial.println(total_frames + 1);
    for (uint16_t s = 0; s <= total_frames; s++) {
        int len = build_frame(s, buf);
        Serial.print("F:");
        for (int i = 0; i < len; i++) {
            if (buf[i] < 16) Serial.print('0');
            Serial.print(buf[i], HEX);
        }
        Serial.println();
        if ((s & 15) == 0) hw_wdt_kick();
    }
    Serial.println("DUMP: end");
}
