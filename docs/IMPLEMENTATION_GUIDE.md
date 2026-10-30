# PneumoScreen — Phase-by-Phase Implementation Guide

> **Purpose:** step-by-step roadmap from the current prototype state to a working, demonstrable device.  
> **Last updated:** 30 October 2026  
> **Companion docs:** [`HANDOVER.md`](../HANDOVER.md) (detailed engineering log), [`README.md`](../README.md) (quick setup)

---

## 1  Status at a Glance

**Overall progress: ≈ 40 %.** Phase 3 (on-device lung-sound pipeline) is implemented and ready for board testing. Body temperature (MLX90614) is **on hold**.

| # | Phase | Status | Done |
|---|---|---|---|
| 0 | Hardware & tools | Board ready, LED/button test sketch written, external sensors **not yet purchased** | 80 % |
| 1 | Data | 5 datasets downloaded, 40 477 labelled windows built | **100 %** |
| 2 | Lung-sound model | v1 CNN, 20.8 KB int8, 56.9 % test accuracy | 60 % |
| 3 | On-device audio pipeline | Full sketch written: PDM → decimate → MFCC → TFLite → LEDs. Needs board test | 70 % |
| 4 | Vital signs | Accel breath rate written but unreliable; camera / SpO₂ not started. **Temp on hold** | 10 % |
| 5 | Integration & alerts | — | 0 % |
| 6 | Web dashboard | — | 0 % |
| 7 | Testing, demo & docs | Handover + README only | 10 % |

### Critical path

```
P0 (buy parts)
  │
  ├──▶ P3 (on-device lung sound)  ──▶ P5 (integration) ──▶ P6 (dashboard) ──▶ P7 (demo)
  │
  └──▶ P4 (vital signs)  ────────────┘
             ▲
P2 (improve model) runs in parallel on the PC
```

---

## 2  Corrected Hardware & Wiring

> 📐 See [`docs/wiring_diagram.svg`](wiring_diagram.svg) for the visual wiring diagram.

### 2.1  Board variant

The board is the **Arduino Nano 33 BLE Sense Rev2** (confirmed by the BMI270 IMU responding at runtime). Three built-in sensors differ from the design document (v2.0):

| Sensor | Design doc says | Actual (Rev2) | Library to use |
|---|---|---|---|
| IMU | LSM9DS1 | **BMI270 + BMM150** | `Arduino_BMI270_BMM150` |
| Temp / humidity | HTS221 | **HS3003** | `Arduino_HS300x` |
| Microphone | PDM | PDM (same) | `PDM` (built-in) |

The HS3003 measures **ambient air temperature**, not body temperature. An external sensor is required for fever detection — see §2.3.

### 2.2  Pin assignment (corrected)

The original wiring diagram has a **pin conflict**: the OV7670 camera (via the TinyML Shield) occupies D0–D6, D8–D10, A0 and A1. The diagram placed the push-button on D2, the red LED on D9 and the green LED on D10 — all three clash with the camera data bus.

**Corrected assignment:**

| Arduino pin | Connected to | Notes |
|---|---|---|
| 3.3 V | MAX30102 VCC, SSD1306 VCC, MLX90614 VCC | shared 3.3 V rail |
| GND | MAX30102 GND, SSD1306 GND, MLX90614 GND, LED cathodes | shared ground |
| A4 (SDA) | MAX30102 SDA, SSD1306 SDA, MLX90614 SDA | I²C data (shared bus) |
| A5 (SCL) | MAX30102 SCL, SSD1306 SCL, MLX90614 SCL | I²C clock (shared bus) |
| D11 | Red LED anode → 220 Ω → GND | abnormal alert |
| D12 | Green LED anode → 220 Ω → GND | normal result |
| D13 | TinyML Shield onboard button | mode select (accel / camera); active LOW with built-in pull-up |
| D0–D10, A0–A1 | OV7670 via TinyML Shield | camera data bus, VSYNC, HREF, PCLK, XCLK — no user wiring needed |

### 2.3  I²C address map

All four I²C peripherals share the A4/A5 bus with no address collisions:

| Device | Address | Purpose |
|---|---|---|
| OV7670 (SCCB) | 0x21 | Camera (managed by library) |
| MAX30102 | 0x57 | SpO₂ + heart rate |
| SSD1306 OLED | 0x3C | 128×64 display (optional) |
| MLX90614 | 0x5A | Contactless IR body temperature |

### 2.4  Bill of materials — still to buy

| Component | Purpose | Approx. cost |
|---|---|---|
| MAX30102 breakout (I²C) | SpO₂ + heart rate | $3–5 |
| MLX90614 GY-906 (I²C) | Contactless body temperature | $4–7 |
| Red LED (3 mm or 5 mm) | Abnormal alert indicator | $0.10 |
| Green LED (3 mm or 5 mm) | Normal result indicator | $0.10 |
| 2 × 220 Ω resistors | Current limiting for LEDs | $0.10 |
| 0.96″ SSD1306 OLED (I²C, optional) | Standalone result display | $2–4 |
| Jumper wires (M-M, M-F) | Breadboard connections | $1–2 |
| **Total** | | **≈ $11–19** |

> **Note on MAX30102 breakouts:** many cheap boards have 4.7 kΩ pull-ups to 1.8 V (on-board regulator). These are too weak for a 3.3 V bus with other devices. Either (a) cut the pull-up trace on the breakout or (b) buy a board with a 3.3 V bypass jumper. Test with an I²C scanner first.

---

## 3  Phase 0 — Hardware Verification

**Goal:** confirm every component works individually before combining them.

**Current state:** board and toolchain are ready; external parts not yet purchased.

### Steps

1. **Purchase** the components in §2.4.
2. **I²C scanner test.** Upload the standard `Wire` I²C scanner sketch. With MAX30102, OLED, and MLX90614 connected to A4/A5 and 3.3 V:
   - Expect addresses: `0x21` (camera, if shield is plugged in), `0x57`, `0x3C`, `0x5A`.
   - If any device is missing, check wiring and the 3.3 V rail current (the Nano 33 BLE can supply ≈ 50 mA on 3.3 V; all four devices draw < 30 mA combined).
3. **LED blink test.** Simple sketch that toggles D11 and D12 every 500 ms. Confirm both LEDs light up.
4. **Shield button test.** Read D13 with `INPUT_PULLUP`; print state to Serial. Press the shield button; confirm it reads LOW.
5. **Camera quick test.** Use the `Harvard_TinyMLx` library's `test_camera` example or `CameraCapture` from `Arduino_OV767X`. Verify that QCIF or QQVGA frames appear in the Serial Monitor.

### Exit criteria

- [ ] I²C scanner finds all connected devices (0x57 and 0x5A minimum; 0x3C if OLED attached)
- [ ] Both LEDs blink
- [ ] D13 button reads LOW when pressed
- [ ] Camera captures at least one frame without error

---

## 4  Phase 1 — Data (complete)

5 datasets are downloaded and segmented. No further work needed unless you want to add KAUH to training later (see Phase 2).

| Dataset | Windows | Source |
|---|---|---|
| ICBHI 2017 | ~4 600 | `data/audio_and_txt_files/` |
| HF_Lung_V1 | ~16 000 | `data/external/hf_lung_v1/` |
| SPRSound | ~8 000 | `data/external/sprsound/` |
| ESC-50 (noise) | ~6 000 | `data/external/esc50/` |
| KAUH | 336 (not used) | `data/external/kauh/` |

Regenerate with:
```bash
python build_dataset.py   # → data/dataset_v2.npz (240 MB)
```

---

## 5  Phase 2 — Improve the Lung-Sound Model

**Goal:** raise accuracy from 56.9 % (window-level) to a clinically useful level.

**Current state:** first model trained (32 epochs, 20.8 KB int8). Per-class int8 recall: normal 51 %, crackles 48 %, wheezes 56 %, noise 88 %. Children with pneumonia (SPRSound): crackle recall 72 %, wheeze recall 63 %.

> This phase runs **in parallel** on the PC while Phases 3–4 use the board.

### Steps

1. **Recording-level aggregation.** Instead of classifying one 2 s window, aggregate the softmax scores over 10–20 s (5–10 windows per chest position) and take the argmax. This simulates how the device will actually work. Measure recall at the recording level, not the window level. Add a script `tools/aggregate_eval.py`.
2. **Try log-mel spectrogram input.** Replace MFCC (13 × 124) with log-mel (32 × 124). This keeps more frequency detail; the CNN is small enough that the larger input still fits in SRAM. Compare on the same test split.
3. **KAUH external test.** Evaluate the current model on KAUH (336 recordings, 5 pneumonia patients). KAUH was recorded with a real stethoscope, so it tests generalisation. Script: `tools/eval_kauh.py`.
4. **Optional — board recording fine-tune.** Use `tools/record_board.py replay` to re-record 200–500 clips through a speaker into the board's PDM mic. Add these to the training set as a third augmentation copy. This closes the microphone domain gap.
5. **Optional — SpecAugment / mixup.** Add time-masking and frequency-masking in `train.py`.

### Files to create or change

| File | Action |
|---|---|
| `tools/aggregate_eval.py` | new — recording-level evaluation |
| `tools/eval_kauh.py` | new — KAUH external test |
| `train.py` | optional edits for log-mel, SpecAugment |
| `pneumo_features.py` | add `log_mel()` variant if using log-mel |
| `firmware/lung_sound/model.h` | regenerated after retraining |

### Exit criteria

- [ ] Recording-level crackle recall ≥ 80 % on SPRSound children with pneumonia, **or** window-level accuracy ≥ 65 %
- [ ] KAUH results documented in `models/training_report.md`

---

## 6  Phase 3 — On-Device Lung-Sound Pipeline

**Goal:** the board captures audio, computes MFCC features, runs the TFLite model, and prints the classification over Serial. LEDs show the result (D11 red = crackles/wheezes, D12 green = normal).

**Current state:** Full pipeline implemented — sketch, portable MFCC library, DSP table export, feed-mode validation tool and host parity test. Needs board testing.

> **Note:** The Mbed OS Nano core has **no CMSIS-DSP** (`arm_math.h` not found). All DSP is implemented in portable C++ (`mfcc.cpp`): our own 128-point radix-2 FFT, Hann window, mel filterbank, log compression and DCT-II. The TFLite Micro library is **Chirale_TensorFLowLite 2.0.0**, which matches the op versions produced by TF 2.21.

### Architecture

```
PDM 16 kHz → Decimator (63-tap FIR, ÷4) → 4 kHz ring buffer (8000 samples)
  ↓ every 1 s (50% overlap of 2 s windows)
RMS normalise → Hann → FFT128 → power → mel(32) → log → clip top_db=80 → DCT → 13 MFCCs
  ↓
z-score normalise (MFCC_MEAN/STD) → int8 quantise → TFLite Invoke → softmax
  ↓
D11 red (crackles/wheezes) or D12 green (normal), 10 s averaged RESULT
```

### Steps (implemented)

1. **Export DSP tables** — `tools/export_dsp.py` generates `firmware/lung_sound/dsp_tables.h`:
   - Sparse mel filterbank `MEL_COEFF[32][max_len]` with `MEL_START` / `MEL_LEN` arrays
   - Periodic Hann window `DSP_HANN[128]`
   - Orthonormal DCT-II matrix `DSP_DCT[13][32]`
   - FFT twiddle factors `DSP_TWIDDLE_RE/IM[64]`
   - Anti-alias decimation FIR `DSP_DECIM_TAPS[63]` (cutoff 1800 Hz)

2. **Portable MFCC** — `firmware/lung_sound/mfcc.h` / `mfcc.cpp`: plain C++ (no Arduino deps).
   - `Decimator`: 16 kHz int16 → 4 kHz float via FIR polyphase
   - `compute_mfcc()`: subtract mean, ÷RMS, framed Hann → own FFT128 → power → mel → log10 → top_db clip → DCT
   - `quantize_input()`: z-score → affine int8 quantisation matching `model.h`

3. **Host parity test** — `tools/mfcc_host.cpp` + `tools/check_mfcc.py` compare the C++ MFCC output against `pneumo_features.mfcc()` on ~20 WAV clips. Target: max abs error < 0.5.

4. **Board sketch** — `firmware/lung_sound/lung_sound.ino`:
   - PDM ISR → staging buffer → `loop()` decimates into 4 kHz ring
   - Inference every 1 s (2 s window, 50 % overlap), silence gate on raw RMS
   - 10 s averaged `RESULT` per chest position; shield button D13 restarts
   - CSV output: `CSV:LUNG,<ms>,<label>,<p0>,<p1>,<p2>,<p3>,<us_dsp>,<us_infer>`
   - Feed mode: PC sends `F` + 32 000 int16 → board returns features + class

5. **Board validation** — `tools/feed_board.py feed` (serial parity) and `live` (microphone).

### Files

| File | Action |
|---|---|
| `tools/export_dsp.py` | new — generates `dsp_tables.h` |
| `firmware/lung_sound/dsp_tables.h` | new (generated) |
| `firmware/lung_sound/mfcc.h` | new — portable MFCC header |
| `firmware/lung_sound/mfcc.cpp` | new — portable MFCC implementation |
| `firmware/lung_sound/lung_sound.ino` | new — the main inference sketch |
| `firmware/lung_sound/model.h` | already exists (unchanged) |
| `tools/mfcc_host.cpp` | new — PC-side MFCC for parity testing |
| `tools/check_mfcc.py` | new — automated parity comparison |
| `tools/feed_board.py` | new — board feed/validation tool |
| `docs/wiring_diagram.svg` | new — corrected wiring diagram |

### Exit criteria

- [ ] `check_mfcc.py` reports max abs error < 0.5 on all coefficients (PC parity)
- [ ] Both sketches compile: `arduino-cli compile --fqbn arduino:mbed_nano:nano33ble`
- [ ] Board prints correct class for a crackle clip played from a phone speaker
- [ ] Board MFCC features match Python within 0.5 via `feed_board.py feed`
- [ ] Inference time measured and recorded (update slides if ≠ "< 50 ms")
- [ ] Tensor arena size documented

---

## 7  Phase 4 — Vital Signs

**Goal:** each vital sign works reliably as a standalone module before integration.

### 4a  Accelerometer Breath Rate (tune existing code)

**Current state:** `firmware/breath_rate/breath_rate.ino` exists but reads ≈ 99 /min on a still surface and is unreliable on the chest. The tuning tool `tools/record_imu.py` is written but has never been run.

**Steps:**
1. Upload the current sketch (it has the raw `r` mode).
2. Run `tools/record_imu.py` to record `still` (30 s), `chest_normal` (60 s) and `chest_fast` (40 s) sessions. Hand-count breaths during recording.
3. Replay the CSVs through a Python port of the firmware algorithm. Likely fixes (from HANDOVER §5.4):
   - Raise `MIN_STD_G` above the measured still-board level (if the floor reads ≈ 2 mg, set it to ≥ 3 mg).
   - Reject autocorrelation estimates at the `LAG_MIN` boundary (that produces the 99 /min ghost).
   - Raise `MIN_QUALITY` from 0.35 to ≈ 0.5.
   - Clear the ring buffer on "too much movement" instead of keeping corrupted data.
4. Flash the tuned sketch and re-test.

**Exit criteria:**
- [ ] Still board (desk/floor): displays "No breathing detected"
- [ ] Chest, normal breathing: within ±3 /min of the hand count
- [ ] Chest, fast breathing (≥ 40 /min): flagged as "FAST" for the selected age group

### 4b  Camera Breath Rate (new)

**Steps:**
1. Write `firmware/breath_camera/breath_camera.ino`. Use `Arduino_OV767X` or `Harvard_TinyMLx` to capture QQVGA grayscale (160 × 120). Downsample to 80 × 60 in software. **Do not allocate a 160 × 120 buffer** — read directly into 80 × 60 by skipping every other row and column, or use the library's `QCIF` mode (176 × 144, crop centre 80 × 60).
2. Compute SAD (sum of absolute differences) between consecutive frames.
3. Feed the SAD signal into the same autocorrelation + peak-detection logic from `breath_rate.ino`.
4. Test: point camera at your chest from 25–30 cm, breathe normally.

**Exit criteria:**
- [ ] Produces a stable breath rate within ±5 /min of a hand count in good lighting
- [ ] Prints "No movement" when pointed at a wall

### 4c  SpO₂ + Heart Rate — MAX30102 (new)

**Steps:**
1. Write `firmware/spo2/spo2.ino` using the `SparkFun MAX3010x` library.
2. **Non-blocking reads.** The design doc's `spo2_read()` blocks for 1–4 s (fills a 100-sample buffer synchronously). Instead, accumulate samples in `loop()` one at a time and compute SpO₂/HR when 100 samples are ready. This lets other sensors run between samples.
3. Print `CSV:<ms>,<spo2>,<hr>` every 5 seconds.
4. Validate against a commercial fingertip oximeter (if available).

**Exit criteria:**
- [ ] Finger on sensor: SpO₂ reads 95–100 %, HR reads 60–100 BPM
- [ ] No finger: prints "No finger detected" (IR level check)
- [ ] Does not block `loop()` for more than 10 ms per call

### 4d  Body Temperature — MLX90614 ⏸ ON HOLD

> **On hold** per project decision (30 Oct 2026). The MLX90614 sensor has not been purchased and body temperature is deferred until the core pipeline (lung sounds + SpO₂ + breath rate) is validated. The I²C address 0x5A is reserved on the bus.

**Steps (when resumed):**
1. Install the `Adafruit MLX90614` library.
2. Write `firmware/temperature/temperature.ino`. Read object temperature (`readObjectTempC()`), not ambient.
3. Point at the forehead from 2–3 cm. Normal: 36.1–37.2 °C. Fever: ≥ 38.0 °C.
4. Compare with a clinical thermometer.

**Exit criteria:**
- [ ] Reads within ±0.5 °C of a clinical thermometer on a person's forehead
- [ ] Correctly flags "FEVER" at ≥ 38.0 °C

---

## 8  Phase 5 — Full Firmware Integration

**Goal:** a single sketch that runs all sensors in sequence (not simultaneously) and outputs a screening result.

### Design: guided screening sequence

Running all sensors at once causes RAM and timing conflicts (PDM buffer overflow during blocking SpO₂ reads, camera and mic competing for DMA). Instead, the firmware runs a **state machine**:

```
IDLE → TEMP → SPO2 → BREATH (accel or camera) → LUNG (×4 chest positions) → RESULT
```

The CHW follows on-screen prompts (OLED) or serial instructions at each step.

### Steps

1. Create `firmware/pneumoscreen/` with modular files:
   - `pneumoscreen.ino` — setup, state machine, serial/OLED output
   - `lung_sound.h / .cpp` — PDM + MFCC + TFLite (from Phase 3)
   - `breath_rate.h / .cpp` — accelerometer or camera (from Phase 4a/4b)
   - `spo2.h / .cpp` — MAX30102 non-blocking (from Phase 4c)
   - `temperature.h / .cpp` — MLX90614 (from Phase 4d)
   - `model.h`, `mel_filterbank.h` — model data
   - `alerts.h` — WHO IMCI decision rules

2. **WHO IMCI decision rules** (in `alerts.h`):

   | Condition | Threshold | Action |
   |---|---|---|
   | Fast breathing (under 2 months) | ≥ 60 /min | flag DANGER |
   | Fast breathing (2–12 months) | ≥ 50 /min | flag DANGER |
   | Fast breathing (1–5 years) | ≥ 40 /min | flag DANGER |
   | Low SpO₂ | < 90 % | flag DANGER |
   | Fever + crackles | ≥ 38.0 °C AND crackles detected | flag HIGH RISK |
   | Crackles or wheezes alone | any | flag REFER |
   | All normal | — | flag NORMAL |

3. **Output format** (single CSV line per completed screening):
   ```
   SCREEN,<version>,<timestamp_ms>,<age_group>,<temp_C>,<spo2_%>,<hr_bpm>,<breath_bpm>,<breath_method>,<lung_label>,<lung_confidence>,<alert_level>
   ```

4. **LED output:** green = NORMAL, red = any flag. **OLED** (optional): show each step's result as it completes, final summary at the end.

5. **Mode selection at startup:** shield button (D13) held during boot = camera mode; not held = accelerometer mode.

### Files to create

| File | Action |
|---|---|
| `firmware/pneumoscreen/pneumoscreen.ino` | new |
| `firmware/pneumoscreen/lung_sound.h` | new (refactored from P3) |
| `firmware/pneumoscreen/breath_rate.h` | new (refactored from P4a/4b) |
| `firmware/pneumoscreen/spo2.h` | new (refactored from P4c) |
| `firmware/pneumoscreen/temperature.h` | new (refactored from P4d) |
| `firmware/pneumoscreen/alerts.h` | new |
| `firmware/pneumoscreen/model.h` | copy from `firmware/lung_sound/` |
| `firmware/pneumoscreen/mel_filterbank.h` | copy from `firmware/lung_sound/` |

### Exit criteria

- [ ] Full screening sequence completes in < 3 minutes
- [ ] `SCREEN,...` CSV line prints with all fields populated
- [ ] Crackle audio + low SpO₂ → DANGER alert, red LED
- [ ] Normal audio + normal vitals → NORMAL, green LED
- [ ] Compiles with < 200 KB flash and < 180 KB SRAM

---

## 9  Phase 6 — Web Dashboard

**Goal:** a live dashboard on any browser (local network) that reads serial data and displays the screening results.

### Option A: Node-RED (recommended for speed)

1. Install Node-RED + `node-red-dashboard` + `node-red-node-serialport` (instructions in design doc §14).
2. Create a flow that parses the `SCREEN,...` CSV line.
3. Dashboard panels: temperature, SpO₂ gauge, HR gauge, breath rate chart, lung sound result, alert banner, patient log table.
4. Export the flow as `dashboard/nodered_flow.json`.

### Option B: Python + HTML (recommended for customisation)

1. Adapt the design doc's `dashboard_bridge.py` to parse the new `SCREEN,...` format.
2. Build a single-page HTML dashboard (`dashboard/index.html`) with WebSocket client.
3. Show the same panels as Option A.

### Files to create

| File | Action |
|---|---|
| `dashboard/nodered_flow.json` | new (Option A) |
| `dashboard/bridge.py` | new (Option B) |
| `dashboard/index.html` | new (Option B) |

### Exit criteria

- [ ] Dashboard shows live data from the board within 2 seconds of a completed screening
- [ ] Alert banner turns red on any abnormal finding
- [ ] Patient log shows the last 20 screenings with timestamps

---

## 10  Phase 7 — Testing, Demo & Documentation

**Goal:** a repeatable demo script and updated documentation.

### Steps

1. **Bench test matrix.** Test every combination:

   | Test | Input | Expected |
   |---|---|---|
   | Crackle audio (phone speaker) | `data/crackles/110_1b1_Ll_sc_Meditron_0.wav` | CRACKLES, red LED |
   | Normal audio | `data/normal/101_1b1_Al_sc_Meditron_0.wav` | NORMAL, green LED |
   | Wheeze audio | any wheeze clip | WHEEZES, red LED |
   | SpO₂ normal | finger on MAX30102 | 95–100 % |
   | SpO₂ low (simulated) | squeeze finger hard | < 95 %, alert |
   | Breath rate normal | board on chest, breathe normally | 12–20 /min |
   | Breath rate fast | breathe at ≈ 40 /min | FAST flag |
   | Temperature normal | forehead at 2 cm | 36–37 °C |
   | Temperature fever | (cannot easily simulate) | flag if ≥ 38 °C |

   > **Demo tip:** the design doc says to use "patient 110" for crackle demo, but patient 110's recordings are mostly normal cycles. Use the segmented clips in `data/crackles/` instead (HANDOVER §9.7).

2. **Update the pitch deck slides:**
   - Slide 2: change "16 kHz" to "4 kHz", "ICBHI 920 recordings" to "5 datasets, 40 000+ windows", "HTS221" to "MLX90614", and "< 50 ms" to the measured time.
   - Slide 3: update the wiring diagram with the corrected pin assignments.

3. **Update the design doc** with all corrections listed in §12 below.

4. **Safety statement.** Add to the README and any presentation:
   > *PneumoScreen is a screening aid for Community Health Workers. It is not a medical diagnostic device. All positive findings should be confirmed by a qualified clinician. The device has not been validated in a clinical trial.*

### Exit criteria

- [ ] All 9 bench tests pass
- [ ] Demo runs end-to-end in < 5 minutes
- [ ] Slides and design doc updated
- [ ] Safety statement in README

---

## 11  Timeline (suggested)

| Week | Work | Depends on |
|---|---|---|
| 1 | P0: buy parts, verify hardware | — |
| 1–2 | P2: model improvements (PC, parallel) | data ready |
| 2–3 | P3: on-device lung sound pipeline | P0 (board) |
| 2–3 | P4a: tune accelerometer breath rate | P0 (board) |
| 3 | P4c: MAX30102 SpO₂ | P0 (parts arrive) |
| 3 | P4d: MLX90614 temperature | P0 (parts arrive) |
| 3–4 | P4b: camera breath rate | P0 (shield) |
| 4 | P5: integration | P3, P4 |
| 4–5 | P6: dashboard | P5 |
| 5 | P7: testing and demo | P5, P6 |

**Minimum viable demo (2–3 weeks):** P0 + P3 + P4a (accel only) + P5 (without camera or temperature) + serial output. This demonstrates lung-sound AI + breath rate + SpO₂ on one device.

---

## 12  Corrections to the Design Document & Slides

These are errors or outdated claims found by comparing the materials with the actual build:

| # | Location | Issue | Correction |
|---|---|---|---|
| 1 | Doc §3, Slide 3 | Button on D2, red LED on D9, green LED on D10 | D13 (shield button), D11, D12 — camera occupies D0–D10 |
| 2 | Doc §3, Slide 2 | Uses `Arduino_LSM9DS1` and `Arduino_HTS221` | Board is Rev2: use `Arduino_BMI270_BMM150` and `Arduino_HS300x` |
| 3 | Doc §11, Slide 2 | "HTS221 built-in sensor" for body temperature | HS3003 measures ambient air; add MLX90614 for body temperature |
| 4 | Doc §6, Slide 2 | "16 kHz, 13 × 98 MFCC, ICBHI 920 recordings" | Model uses 4 kHz, 13 × 124, 5 datasets (40 477 windows) |
| 5 | Doc §10.2 | Camera buffer is 80 × 60 but `Camera.begin(QQVGA, ...)` captures 160 × 120 | Buffer overflow — downsample or use correct resolution |
| 6 | Doc §11.1 | `spo2_read()` blocks for 1–4 s | Overflows PDM buffer; must be non-blocking |
| 7 | Doc §13 | `compute_mfcc()` is a placeholder (copies raw audio) | Must implement real MFCC pipeline matching `pneumo_features.py` |
| 8 | Doc §5.2 | "PhysioNet Respiratory" link is an ECG database | Remove or replace |
| 9 | Doc §16.2 | "Play patient 110 for crackle demo" | Patient 110 is mostly normal; use segmented crackle clips |
| 10 | Doc §4.3 | `tensorflow==2.13.0` | Does not install on Python 3.13; use 2.21.0 |
| 11 | Slide 2 | "Result in < 50 ms" | Not measured yet — update after Phase 3 |
| 12 | Doc §9 | Breath rate threshold is adult-only (> 20 /min) | Must be age-based (WHO IMCI: ≥ 60 / ≥ 50 / ≥ 40 /min) |

---

## 13  Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Model accuracy too low for clinical screening | False negatives miss pneumonia | Aggregate over multiple windows (§5 step 1); fine-tune on board recordings; present results as "screening aid" with referral, not diagnosis |
| Microphone domain gap (dataset stethoscope ≠ board PDM) | Model under-performs on real patients | Microphone simulation augmentation (already in `build_dataset.py`); optional board recording fine-tune |
| 3.3 V rail current limit (~50 mA) | Brownout if all I²C devices + camera draw together | Run sensors sequentially (state machine), not simultaneously; MAX30102 LED current can be reduced |
| MAX30102 breakout 1.8 V pull-ups | I²C bus unreliable at 3.3 V | Cut breakout pull-up traces or buy a 3.3 V-compatible board |
| Only one program can use the serial port | Cannot upload while dashboard is open | Close dashboard / Serial Monitor before uploading; document clearly |
| Low disk space on owner's PC (≈ 7 GB free) | Cannot re-download datasets or run large training jobs | Delete recycled archives; consider external storage; use smaller batch sizes |

---

*PneumoScreen — Implementation Guide v1.0 — 30 October 2026*
