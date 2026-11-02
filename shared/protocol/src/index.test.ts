import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as P from './index';

const header = readFileSync(
  fileURLToPath(new URL('../../../firmware/pneumoscreen/ble_protocol.h', import.meta.url)),
  'utf8',
);
const defines = new Map<string, string>();
for (const m of header.matchAll(/^#define\s+(PS_\w+)\s+("[^"]*"|\S+)/gm)) defines.set(m[1], m[2].replace(/"/g, ''));
const num = (name: string): number => Number(defines.get(name));

describe('matches firmware/pneumoscreen/ble_protocol.h', () => {
  it('uuids and scalars', () => {
    expect(defines.get('PS_UUID_SERVICE')).toBe(P.UUID.service);
    expect(defines.get('PS_UUID_CONTROL')).toBe(P.UUID.control);
    expect(defines.get('PS_UUID_STATUS')).toBe(P.UUID.status);
    expect(defines.get('PS_UUID_DATA')).toBe(P.UUID.data);
    expect(defines.get('PS_UUID_LEVEL')).toBe(P.UUID.level);
    expect(defines.get('PS_DEVICE_NAME')).toBe(P.DEVICE_NAME);
    expect(num('PS_PROTO_VERSION')).toBe(P.PROTO_VERSION);
    expect(num('PS_FRAME_HEADER')).toBe(P.FRAME_HEADER);
    expect(num('PS_STATUS_SIZE')).toBe(P.STATUS_SIZE);
    expect(num('PS_AUDIO_RATE')).toBe(P.AUDIO_RATE);
    expect(num('PS_ACCEL_RATE')).toBe(P.ACCEL_RATE);
    expect(num('PS_MAX_AUDIO_SEC')).toBe(P.MAX_AUDIO_SEC);
    expect(num('PS_MAX_BREATH_SEC')).toBe(P.MAX_BREATH_SEC);
    expect(num('PS_LEVEL_HZ')).toBe(P.LEVEL_HZ);
  });

  const groups: Array<[string, Record<string, number>]> = [
    ['PS_OP_', P.Op], ['PS_STEP_', P.Step], ['PS_STATE_', P.State],
    ['PS_FLAG_', P.Flag], ['PS_ERR_', P.Err], ['PS_KIND_', P.Kind],
  ];
  it.each(groups)('%s enum', (prefix, obj) => {
    const fromHeader = Object.fromEntries(
      [...defines].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), Number(v)]),
    );
    expect(fromHeader).toEqual(obj);
  });
});

describe('commands', () => {
  it('encodes little-endian', () => {
    expect([...P.startStep(P.Step.LUNG_LL, 300)]).toEqual([0x01, 5, 0x2c, 0x01]);
    expect([...P.resend(2, 0x0102)]).toEqual([0x03, 2, 0, 2, 1]);
    expect([...P.ping(0xdeadbeef)]).toEqual([0x05, 0xef, 0xbe, 0xad, 0xde]);
    expect([...P.stop()]).toEqual([0x02]);
    expect([...P.doneAck()]).toEqual([0x04]);
  });
});

describe('status and level', () => {
  it('parses a status packet', () => {
    const b = new Uint8Array(20);
    const v = new DataView(b.buffer);
    b.set([1, 2, 0, P.Flag.SAFE_MODE | P.Flag.MIC_OK, P.State.HOLDING, P.Step.BREATH, 100, 0]);
    v.setUint16(8, 42, true);
    v.setUint16(10, 240, true);
    v.setUint32(12, 7, true);
    v.setUint32(16, 3600, true);
    expect(P.parseStatus(b)).toMatchObject({
      fw: '2.0', safeMode: true, state: P.State.HOLDING, step: P.Step.BREATH,
      progress: 100, framesTotal: 42, payloadMax: 240, pingToken: 7, uptimeS: 3600,
    });
    expect(() => P.parseStatus(new Uint8Array(19))).toThrow();
  });
  it('parses level', () => {
    expect(P.parseLevel(Uint8Array.of(0x10, 0x27, 1))).toEqual({ rms: 1, clipped: true });
  });
});

describe('crc32', () => {
  it('matches the IEEE check value', () => {
    expect(P.crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

// Build the frames a board would send for one step.
function boardFrames(step: P.StepId, parts: Array<[number, Uint8Array]>, payloadMax: number): Uint8Array[] {
  const frames: Uint8Array[] = [];
  const all: Uint8Array[] = [];
  let seq = 0;
  for (const [kind, data] of parts) {
    for (let o = 0; o < data.length; o += payloadMax) {
      const p = data.subarray(o, o + payloadMax);
      const f = new Uint8Array(P.FRAME_HEADER + p.length);
      new DataView(f.buffer).setUint16(0, seq++, true);
      f[2] = kind;
      f[3] = step;
      f.set(p, P.FRAME_HEADER);
      frames.push(f);
      all.push(p);
    }
  }
  const joined = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of all) { joined.set(p, o); o += p.length; }
  const end = new Uint8Array(P.FRAME_HEADER + 10);
  const v = new DataView(end.buffer);
  v.setUint16(0, seq, true);
  end[2] = P.Kind.END;
  end[3] = step;
  v.setUint16(4, seq, true);
  v.setUint32(6, joined.length, true);
  v.setUint32(10, P.crc32(joined), true);
  frames.push(end);
  return frames;
}

describe('StepAssembler', () => {
  const pcm = new Int16Array(40000).map((_, i) => Math.round(Math.sin(i / 7) * 12000));
  const pcmBytes = new Uint8Array(pcm.buffer);

  it('reassembles audio and reports gaps for RESEND', () => {
    const frames = boardFrames(P.Step.LUNG_RU, [[P.Kind.AUDIO, pcmBytes]], 240);
    const dropped = new Set([0, 5, 6, 7, frames.length - 2]);
    const a = new P.StepAssembler(P.Step.LUNG_RU);
    frames.forEach((f, i) => { if (!dropped.has(i)) a.add(P.parseFrame(f)); });
    const last = frames.length - 2;
    expect(a.endSeen).toBe(true);
    expect(a.missing()).toEqual([[0, 0], [5, 7], [last, last]]);
    expect(a.complete()).toBe(false);
    for (const [from, to] of a.missing()) for (let s = from; s <= to; s++) a.add(P.parseFrame(frames[s]));
    expect(a.missing()).toEqual([]);
    expect(a.complete()).toBe(true);
    expect(a.result().audio).toEqual(pcm);
  });

  it('works with a small MTU (20-byte payloads)', () => {
    const frames = boardFrames(P.Step.LUNG_LU, [[P.Kind.AUDIO, pcmBytes.subarray(0, 2000)]], 16);
    const a = new P.StepAssembler(P.Step.LUNG_LU);
    frames.reverse().forEach((f) => a.add(P.parseFrame(f)));
    expect(a.complete()).toBe(true);
    expect(a.result().audio).toEqual(pcm.subarray(0, 1000));
  });

  it('rejects a corrupted payload via CRC', () => {
    const frames = boardFrames(P.Step.LUNG_RL, [[P.Kind.AUDIO, pcmBytes.subarray(0, 960)]], 240);
    frames[1][P.FRAME_HEADER + 3] ^= 0xff;
    const a = new P.StepAssembler(P.Step.LUNG_RL);
    frames.forEach((f) => a.add(P.parseFrame(f)));
    expect(a.missing()).toEqual([]);
    expect(a.complete()).toBe(false);
  });

  it('decodes a breath step (accel + result)', () => {
    const accel = new Int16Array([10, -20, 1000, 12, -18, 998]);
    const frames = boardFrames(
      P.Step.BREATH,
      [[P.Kind.ACCEL, new Uint8Array(accel.buffer)], [P.Kind.BREATH, Uint8Array.of(44, 87)]],
      240,
    );
    const a = new P.StepAssembler(P.Step.BREATH);
    frames.forEach((f) => a.add(P.parseFrame(f)));
    expect(a.result()).toMatchObject({ accel, breath: { bpm: 44, quality: 87 } });
  });

  it('ignores frames from another step', () => {
    const a = new P.StepAssembler(P.Step.TEMP);
    const [f] = boardFrames(P.Step.SPO2, [[P.Kind.SPO2, Uint8Array.of(97, 120, 80)]], 240);
    expect(a.add(P.parseFrame(f))).toBe(false);
  });

  it('converts pcm to float like the board decimator', () => {
    expect([...P.pcmToFloat(Int16Array.of(-32768, 0, 16384))]).toEqual([-1, 0, 0.5]);
  });
});
