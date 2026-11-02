// PneumoScreen BLE gateway protocol v1. Byte layouts: docs/BLE_PROTOCOL.md.
// Constants mirror firmware/pneumoscreen/ble_protocol.h (checked by a test).

export const PROTO_VERSION = 1;
export const DEVICE_NAME = 'PneumoScreen';

export const UUID = {
  service: '42b50001-8e74-401f-9f6a-42fe6d9a3bc4',
  control: '42b50002-8e74-401f-9f6a-42fe6d9a3bc4',
  status: '42b50003-8e74-401f-9f6a-42fe6d9a3bc4',
  data: '42b50004-8e74-401f-9f6a-42fe6d9a3bc4',
  level: '42b50005-8e74-401f-9f6a-42fe6d9a3bc4',
} as const;

export const Op = { START_STEP: 0x01, STOP: 0x02, RESEND: 0x03, DONE_ACK: 0x04, PING: 0x05 } as const;

export const Step = {
  NONE: 0, BREATH: 1, LUNG_RU: 2, LUNG_LU: 3, LUNG_RL: 4, LUNG_LL: 5, TEMP: 6, SPO2: 7,
} as const;
export type StepId = (typeof Step)[keyof typeof Step];

export const STEP_NAMES: Record<StepId, string> = {
  0: 'none', 1: 'breath', 2: 'lung_RU', 3: 'lung_LU', 4: 'lung_RL', 5: 'lung_LL', 6: 'temp', 7: 'spo2',
};

export const State = { IDLE: 0, RECORDING: 1, TRANSFERRING: 2, HOLDING: 3, ERROR: 4 } as const;

export const Flag = {
  SAFE_MODE: 0x01, MIC_OK: 0x02, IMU_OK: 0x04, TEMP_OK: 0x08, SPO2_OK: 0x10, OLED_OK: 0x20,
} as const;

export const Err = { NONE: 0, BAD_CMD: 1, NO_SENSOR: 2, NO_MEMORY: 3, BUSY: 4, TOO_LONG: 5 } as const;

export const Kind = { AUDIO: 0x01, ACCEL: 0x02, BREATH: 0x03, TEMP: 0x04, SPO2: 0x05, END: 0x7f } as const;

export const FRAME_HEADER = 4;
export const STATUS_SIZE = 20;
export const AUDIO_RATE = 4000;
export const ACCEL_RATE = 10;
export const MAX_AUDIO_SEC = 12;
export const MAX_BREATH_SEC = 60;
export const LEVEL_HZ = 10;

// ── control commands ─────────────────────────────────────────

export function startStep(step: StepId, seconds: number): Uint8Array {
  const b = new Uint8Array(4);
  const v = new DataView(b.buffer);
  v.setUint8(0, Op.START_STEP);
  v.setUint8(1, step);
  v.setUint16(2, seconds, true);
  return b;
}
export const stop = (): Uint8Array => Uint8Array.of(Op.STOP);
export const doneAck = (): Uint8Array => Uint8Array.of(Op.DONE_ACK);

export function resend(fromSeq: number, toSeq: number): Uint8Array {
  const b = new Uint8Array(5);
  const v = new DataView(b.buffer);
  v.setUint8(0, Op.RESEND);
  v.setUint16(1, fromSeq, true);
  v.setUint16(3, toSeq, true);
  return b;
}

export function ping(token: number): Uint8Array {
  const b = new Uint8Array(5);
  const v = new DataView(b.buffer);
  v.setUint8(0, Op.PING);
  v.setUint32(1, token >>> 0, true);
  return b;
}

// ── notifications ────────────────────────────────────────────

export interface DeviceStatus {
  proto: number;
  fw: string;
  flags: number;
  safeMode: boolean;
  state: number;
  step: StepId;
  progress: number;
  err: number;
  framesTotal: number;
  payloadMax: number;
  pingToken: number;
  uptimeS: number;
}

const view = (d: DataView | Uint8Array): DataView =>
  d instanceof DataView ? d : new DataView(d.buffer, d.byteOffset, d.byteLength);

export function parseStatus(d: DataView | Uint8Array): DeviceStatus {
  const v = view(d);
  if (v.byteLength < STATUS_SIZE) throw new Error(`status: ${v.byteLength} < ${STATUS_SIZE} bytes`);
  const flags = v.getUint8(3);
  return {
    proto: v.getUint8(0),
    fw: `${v.getUint8(1)}.${v.getUint8(2)}`,
    flags,
    safeMode: (flags & Flag.SAFE_MODE) !== 0,
    state: v.getUint8(4),
    step: v.getUint8(5) as StepId,
    progress: v.getUint8(6),
    err: v.getUint8(7),
    framesTotal: v.getUint16(8, true),
    payloadMax: v.getUint16(10, true),
    pingToken: v.getUint32(12, true),
    uptimeS: v.getUint32(16, true),
  };
}

export interface Level { rms: number; clipped: boolean }

export function parseLevel(d: DataView | Uint8Array): Level {
  const v = view(d);
  return { rms: v.getUint16(0, true) / 10000, clipped: v.byteLength > 2 && v.getUint8(2) !== 0 };
}

export interface Frame { seq: number; kind: number; step: StepId; payload: Uint8Array }

export function parseFrame(d: DataView | Uint8Array): Frame {
  const v = view(d);
  if (v.byteLength < FRAME_HEADER) throw new Error('frame: too short');
  return {
    seq: v.getUint16(0, true),
    kind: v.getUint8(2),
    step: v.getUint8(3) as StepId,
    payload: new Uint8Array(v.buffer, v.byteOffset + FRAME_HEADER, v.byteLength - FRAME_HEADER).slice(),
  };
}

// ── CRC-32 (IEEE 802.3, same as zlib) ────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// ── step reassembly ──────────────────────────────────────────

export interface StepData {
  step: StepId;
  audio?: Int16Array;
  accel?: Int16Array; // interleaved x,y,z (mg, baseline-removed, 10 Hz)
  breath?: { bpm: number; quality: number };
  temp?: { celsius: number; humidity: number };
  spo2?: { spo2: number; hr: number; quality: number };
}

export class StepAssembler {
  private frames = new Map<number, Frame>();
  private end: { total: number; bytes: number; crc: number } | null = null;

  constructor(readonly step: StepId) {}

  /** Returns false for frames that belong to another step (ignored). */
  add(f: Frame): boolean {
    if (f.step !== this.step) return false;
    if (f.kind === Kind.END) {
      const v = view(f.payload);
      this.end = { total: v.getUint16(0, true), bytes: v.getUint32(2, true), crc: v.getUint32(6, true) };
    } else {
      this.frames.set(f.seq, f);
    }
    return true;
  }

  get received(): number { return this.frames.size; }
  get expected(): number | null { return this.end?.total ?? null; }
  get endSeen(): boolean { return this.end !== null; }

  /** Inclusive [from, to] ranges still missing; empty until END arrives unless `upTo` is given. */
  missing(upTo?: number): Array<[number, number]> {
    const total = this.end?.total ?? upTo;
    if (total === undefined) return [];
    const out: Array<[number, number]> = [];
    let start = -1;
    for (let s = 0; s < total; s++) {
      const have = this.frames.has(s);
      if (!have && start < 0) start = s;
      if (have && start >= 0) { out.push([start, s - 1]); start = -1; }
    }
    if (start >= 0) out.push([start, total - 1]);
    return out;
  }

  private payloadBytes(): Uint8Array {
    const total = this.end?.total ?? 0;
    let len = 0;
    for (let s = 0; s < total; s++) len += this.frames.get(s)?.payload.length ?? 0;
    const out = new Uint8Array(len);
    let o = 0;
    for (let s = 0; s < total; s++) {
      const p = this.frames.get(s)?.payload;
      if (p) { out.set(p, o); o += p.length; }
    }
    return out;
  }

  /** True once END arrived, no frame is missing and size + CRC match. */
  complete(): boolean {
    if (!this.end || this.missing().length) return false;
    const bytes = this.payloadBytes();
    return bytes.length === this.end.bytes && crc32(bytes) === this.end.crc;
  }

  result(): StepData {
    if (!this.complete()) throw new Error('step incomplete');
    const byKind = new Map<number, Uint8Array[]>();
    for (let s = 0; s < this.end!.total; s++) {
      const f = this.frames.get(s)!;
      if (!byKind.has(f.kind)) byKind.set(f.kind, []);
      byKind.get(f.kind)!.push(f.payload);
    }
    const join = (parts: Uint8Array[] = []): Uint8Array => {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    };
    const i16 = (b: Uint8Array): Int16Array => {
      const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const out = new Int16Array(b.byteLength >> 1);
      for (let i = 0; i < out.length; i++) out[i] = v.getInt16(i * 2, true);
      return out;
    };
    const res: StepData = { step: this.step };
    if (byKind.has(Kind.AUDIO)) res.audio = i16(join(byKind.get(Kind.AUDIO)));
    if (byKind.has(Kind.ACCEL)) res.accel = i16(join(byKind.get(Kind.ACCEL)));
    const last = (k: number): DataView | null => {
      const p = byKind.get(k);
      return p?.length ? view(p[p.length - 1]) : null;
    };
    const b = last(Kind.BREATH);
    if (b) res.breath = { bpm: b.getUint8(0), quality: b.getUint8(1) };
    const t = last(Kind.TEMP);
    if (t) res.temp = { celsius: t.getInt16(0, true) / 100, humidity: t.getUint16(2, true) / 100 };
    const o = last(Kind.SPO2);
    if (o) res.spo2 = { spo2: o.getUint8(0), hr: o.getUint8(1), quality: o.getUint8(2) };
    return res;
  }
}

/** Audio int16 → float in [-1, 1), the scale the board's MFCC pipeline used. */
export function pcmToFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}
