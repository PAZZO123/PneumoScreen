# PneumoScreen BLE gateway protocol (v1)

The board is a sensor gateway. It records one screening step when the phone asks, then sends the data in numbered frames. The phone (or laptop Chrome during development) runs the prompts, MFCC and the lung model, and keeps the records.

Source of truth:
- `firmware/pneumoscreen/ble_protocol.h` (firmware constants)
- `shared/protocol/src/index.ts` (TypeScript encoders, decoders and `StepAssembler`)

`pnpm --filter @pneumo/protocol test` fails if the two drift apart.

All multi-byte fields are **little-endian**.

## Service

The device advertises as `PneumoScreen`, with service `42b50001-8e74-401f-9f6a-42fe6d9a3bc4`.

| Characteristic | UUID | Props | Purpose |
|---|---|---|---|
| control | `42b50002-…` | write | commands from the phone |
| status | `42b50003-…` | read, notify | 20-byte device status |
| data | `42b50004-…` | notify | numbered data frames |
| level | `42b50005-…` | notify | 10 Hz mic level while recording |

## control (write)

| Op | Bytes | Meaning |
|---|---|---|
| `0x01` START_STEP | `op, step u8, seconds u16` | Discard any held step, record `step` for `seconds`. Audio steps are limited to 12 s, breath to 60 s; otherwise the error is `TOO_LONG`. |
| `0x02` STOP | `op` | End recording early and send what was captured. |
| `0x03` RESEND | `op, from u16, to u16` | Send frames `from..to` again (inclusive). |
| `0x04` DONE_ACK | `op` | The phone has a complete, CRC-checked step. The board frees the buffer and goes IDLE. |
| `0x05` PING | `op, token u32` | The board echoes `token` in status. |

Step ids: `1` breath, `2` lung_RU, `3` lung_LU, `4` lung_RL, `5` lung_LL, `6` temp, `7` spo2.

## status (read / notify, 20 bytes)

| Off | Type | Field |
|---|---|---|
| 0 | u8 | protocol version (1) |
| 1–2 | u8, u8 | firmware major, minor |
| 3 | u8 | flags: `0x01` safe mode, `0x02` mic ok, `0x04` IMU ok, `0x08` temp ok, `0x10` SpO₂ ok, `0x20` OLED ok |
| 4 | u8 | state: `0` idle, `1` recording, `2` transferring, `3` holding, `4` error |
| 5 | u8 | current step id |
| 6 | u8 | progress 0–100 (recording, then transfer) |
| 7 | u8 | error: `0` none, `1` bad cmd, `2` no sensor, `3` no memory, `4` busy, `5` too long |
| 8 | u16 | frames in the current step (excluding END) |
| 10 | u16 | payload bytes per frame (from the negotiated MTU: `mtu − 3 − 4`) |
| 12 | u32 | last PING token |
| 16 | u32 | uptime, seconds |

Status is notified on every state change and once a second.

## data (notify)

Each frame has a 4-byte header: `seq u16, kind u8, step u8`. The payload is the rest of the notification. Its length varies, so take it from the notification length.

| Kind | Payload |
|---|---|
| `0x01` AUDIO | int16 PCM, mono, 4 kHz: the board's 63-tap FIR decimation of the 16 kHz PDM mic, `round(clamp(x·32768))` |
| `0x02` ACCEL | int16 x, y, z in mg, 10 Hz: the smoothed, baseline-removed signal `breath.cpp` analyses |
| `0x03` BREATH | bpm u8, quality u8 (0–100), the board's own estimate |
| `0x04` TEMP | temperature i16 (centi-°C), humidity u16 (centi-%); ambient AHT10 |
| `0x05` SPO2 | SpO₂ u8 %, heart rate u8 bpm, quality u8 |
| `0x7F` END | total_frames u16, payload_bytes u32, crc32 u32 |

The data frames of a step are numbered `0..N−1`. END carries `seq = N`, the frame count N, the byte count, and an **IEEE CRC-32** over the concatenated payloads of frames `0..N−1` in order (the same as `zlib.crc32`).

## level (notify, 3 bytes)

`rms u16` (×10000, of the [-1, 1] signal), `clipped u8`. The phone uses it for the "mic on the chest?" meter.

## Flow for one step

```
phone                         board
START_STEP(lung_RU, 10)  ──▶  state=RECORDING, level @10 Hz, progress
                         ◀──  state=TRANSFERRING; frames 0..N-1; END(N, bytes, crc)
(gaps?) RESEND(a, b)     ──▶  frames a..b again           (repeat as needed)
DONE_ACK                 ──▶  buffer freed, state=IDLE
```

- The board keeps the step in RAM in the **HOLDING** state until DONE_ACK or the next START_STEP. A dropped connection during transfer loses nothing: reconnect, read status, then RESEND.
- If the phone never completes a step (lost, CRC mismatch, timeout), it marks the step **missing** and offers **Re-record**, which sends START_STEP again. The app keeps every attempt.
- Audio memory: 12 s × 4 kHz × 2 B = 96 KB maximum. Breath: 60 s × 10 Hz × 6 B = 3.6 KB.
