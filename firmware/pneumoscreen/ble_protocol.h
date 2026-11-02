// ble_protocol.h – PneumoScreen BLE gateway protocol (v1)
// Mirrored in shared/protocol/src/index.ts; a test there parses this file,
// so keep the "#define NAME value" form. Spec: docs/BLE_PROTOCOL.md
#pragma once

#define PS_PROTO_VERSION   1
#define PS_FW_MAJOR        2
#define PS_FW_MINOR        0
#define PS_DEVICE_NAME     "PneumoScreen"

#define PS_UUID_SERVICE    "42b50001-8e74-401f-9f6a-42fe6d9a3bc4"
#define PS_UUID_CONTROL    "42b50002-8e74-401f-9f6a-42fe6d9a3bc4"
#define PS_UUID_STATUS     "42b50003-8e74-401f-9f6a-42fe6d9a3bc4"
#define PS_UUID_DATA       "42b50004-8e74-401f-9f6a-42fe6d9a3bc4"
#define PS_UUID_LEVEL      "42b50005-8e74-401f-9f6a-42fe6d9a3bc4"

// control opcodes (byte 0 of a control write; all fields little-endian)
#define PS_OP_START_STEP   0x01   // step u8, seconds u16
#define PS_OP_STOP         0x02   // -
#define PS_OP_RESEND       0x03   // from_seq u16, to_seq u16 (inclusive)
#define PS_OP_DONE_ACK     0x04   // - ; board frees the step buffer
#define PS_OP_PING         0x05   // token u32 ; echoed in status

// step ids
#define PS_STEP_NONE       0
#define PS_STEP_BREATH     1
#define PS_STEP_LUNG_RU    2
#define PS_STEP_LUNG_LU    3
#define PS_STEP_LUNG_RL    4
#define PS_STEP_LUNG_LL    5
#define PS_STEP_TEMP       6
#define PS_STEP_SPO2       7

// device states
#define PS_STATE_IDLE         0
#define PS_STATE_RECORDING    1
#define PS_STATE_TRANSFERRING 2
#define PS_STATE_HOLDING      3   // transfer sent, waiting for DONE_ACK / RESEND
#define PS_STATE_ERROR        4

// status flags
#define PS_FLAG_SAFE_MODE  0x01
#define PS_FLAG_MIC_OK     0x02
#define PS_FLAG_IMU_OK     0x04
#define PS_FLAG_TEMP_OK    0x08
#define PS_FLAG_SPO2_OK    0x10
#define PS_FLAG_OLED_OK    0x20

// error codes
#define PS_ERR_NONE        0
#define PS_ERR_BAD_CMD     1
#define PS_ERR_NO_SENSOR   2
#define PS_ERR_NO_MEMORY   3
#define PS_ERR_BUSY        4
#define PS_ERR_TOO_LONG    5

// data frame kinds
#define PS_KIND_AUDIO      0x01   // int16 PCM, mono, 4 kHz
#define PS_KIND_ACCEL      0x02   // int16 x,y,z in mg, baseline-removed, 10 Hz
#define PS_KIND_BREATH     0x03   // bpm u8, quality u8 (0-100)
#define PS_KIND_TEMP       0x04   // temp i16 centi-degC, humidity u16 centi-%
#define PS_KIND_SPO2       0x05   // spo2 u8 %, hr u8 bpm, quality u8
#define PS_KIND_END        0x7F   // total_frames u16, payload_bytes u32, crc32 u32

#define PS_FRAME_HEADER    4      // seq u16, kind u8, step u8
#define PS_STATUS_SIZE     20
#define PS_AUDIO_RATE      4000
#define PS_ACCEL_RATE      10
#define PS_MAX_AUDIO_SEC   12
#define PS_MAX_BREATH_SEC  60
#define PS_LEVEL_HZ        10
