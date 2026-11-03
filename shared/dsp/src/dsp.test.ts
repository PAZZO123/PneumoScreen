import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  computeMfcc, Decimator, DSP, evaluate, triage, ageBand, LungClassifier, MODEL, quantizeInput, roundAway, TfliteModel,
} from './index';
import { multiplyByQuantizedMultiplier, quantizeMultiplier, roundingDivideByPOT, saturatingRoundingDoublingHighMul } from './tflite/interpreter';

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const fx = (name: string): Buffer => readFileSync(here(`../fixtures/${name}`));
const manifest = JSON.parse(fx('manifest.json').toString()) as { windows: number; decim_windows: number; labels: string[]; ref_classes: string[] };
const N = manifest.windows;
const F = DSP.N_MFCC * DSP.N_FRAMES;
const i16 = (b: Buffer): Int16Array => new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const f32 = (b: Buffer): Float32Array => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const i8 = (b: Buffer): Int8Array => new Int8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const maxAbs = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

const pcm4k = i16(fx('pcm4k.i16'));
const refMfcc = f32(fx('mfcc.f32'));
const refInput = i8(fx('input.i8'));
const refLogits = i8(fx('logits.i8'));
const refProbs = i8(fx('probs.i8'));
const windowPcm = (w: number): Int16Array => pcm4k.subarray(w * 8000, (w + 1) * 8000);
const toFloat = (p: Int16Array): Float32Array => Float32Array.from(p, (v) => v / 32768);

const MODEL_PATH = here('../../../models/pneumo_lung_int8.tflite');
const haveModel = existsSync(MODEL_PATH);

describe('generated tables', () => {
  it('match the firmware headers', () => {
    execFileSync(process.execPath, [here('../scripts/extract_tables.mjs'), '--check'], { stdio: 'pipe' });
  });
});

describe('decimator (vs firmware Decimator)', () => {
  it('matches the C++ output', () => {
    const input = i16(fx('decim_in.i16'));
    const ref = f32(fx('decim_out.f32'));
    for (let w = 0; w < manifest.decim_windows; w++) {
      const d = new Decimator();
      const parts: Float32Array[] = [];
      for (let i = 0; i < 32000; i += 512) parts.push(d.process(input.subarray(w * 32000 + i, w * 32000 + Math.min(32000, i + 512))));
      const out = Float32Array.from(parts.flatMap((p) => Array.from(p)));
      expect(out.length).toBe(8000);
      expect(maxAbs(out, ref.subarray(w * 8000, (w + 1) * 8000))).toBeLessThan(1e-6);
    }
  });
});

describe('MFCC (vs firmware compute_mfcc)', () => {
  it(`stays within 1e-3 on all ${N} windows`, () => {
    let worst = 0;
    for (let w = 0; w < N; w++) {
      const out = computeMfcc(toFloat(windowPcm(w)));
      worst = Math.max(worst, maxAbs(out, refMfcc.subarray(w * F, (w + 1) * F)));
    }
    console.log(`MFCC max abs diff vs C++: ${worst.toExponential(2)}`);
    expect(worst).toBeLessThan(1e-3);
  });

  it('rejects short windows', () => {
    expect(() => computeMfcc(new Float32Array(100))).toThrow();
  });
});

describe('quantizer (vs firmware quantize_input)', () => {
  it('is exact on the reference MFCCs', () => {
    for (let w = 0; w < N; w++)
      expect(Array.from(quantizeInput(refMfcc.subarray(w * F, (w + 1) * F)))).toEqual(Array.from(refInput.subarray(w * F, (w + 1) * F)));
  });
  it('rounds halves away from zero like roundf', () => {
    expect([roundAway(2.5), roundAway(-2.5), roundAway(0.4), roundAway(-0.6)]).toEqual([3, -3, 0, -1]);
  });
});

describe('fixed-point helpers (TFLite common.h)', () => {
  it('match known values', () => {
    expect(saturatingRoundingDoublingHighMul(-2147483648, -2147483648)).toBe(2147483647);
    expect(saturatingRoundingDoublingHighMul(1 << 30, 1 << 30)).toBe(1 << 29);
    expect(saturatingRoundingDoublingHighMul(-3, 1 << 30)).toBe(-1);
    expect(roundingDivideByPOT(5, 1)).toBe(3);
    expect(roundingDivideByPOT(-5, 1)).toBe(-3);
    expect(roundingDivideByPOT(-4, 1)).toBe(-2);
    expect(quantizeMultiplier(0.5)).toEqual([1073741824, 0]);
    expect(quantizeMultiplier(0.25)).toEqual([1073741824, -1]);
    const [q, s] = quantizeMultiplier(0.0037);
    expect(multiplyByQuantizedMultiplier(10000, q, s)).toBe(37);
  });
});

describe.skipIf(!haveModel)('int8 model (vs TFLite BUILTIN_REF kernels)', () => {
  const model = haveModel ? new TfliteModel(readFileSync(MODEL_PATH)) : (null as never);
  const clf = haveModel ? new LungClassifier(model) : (null as never);
  const logitsIdx = haveModel ? model.tensors.findIndex((t) => t.name.startsWith('functional_1/dense_1/MatMul;')) : -1;

  it('parses the model', () => {
    expect(model.input.shape).toEqual([1, 13, 124, 1]);
    expect(model.output.shape).toEqual([1, 4]);
    expect(model.ops.length).toBe(9);
    expect(logitsIdx).toBeGreaterThan(0);
  });

  it('logits are bit-exact, softmax within one step', () => {
    let softmaxWorst = 0;
    for (let w = 0; w < N; w++) {
      const { raw } = clf.runQuantized(refInput.slice(w * F, (w + 1) * F));
      // @ts-expect-error reach the interpreter for the intermediate tensor
      const logits = clf.interp.tensor(logitsIdx) as Int8Array;
      expect(Array.from(logits)).toEqual(Array.from(refLogits.subarray(w * 4, w * 4 + 4)));
      softmaxWorst = Math.max(softmaxWorst, maxAbs(raw, refProbs.subarray(w * 4, w * 4 + 4)));
    }
    console.log(`softmax max diff vs TFLite: ${softmaxWorst} step(s)`);
    expect(softmaxWorst).toBeLessThanOrEqual(1);
  });

  it(`gives the reference class on all ${N} windows, end to end from 4 kHz PCM`, () => {
    const got = Array.from({ length: N }, (_, w) => clf.classifyWindow(toFloat(windowPcm(w))).best);
    expect(got).toEqual(manifest.ref_classes);
  });

  it('classifies a 10 s clip with the silence gate and averaging', () => {
    const clip = new Int16Array(40000);
    clip.set(windowPcm(5), 0);
    clip.set(windowPcm(5), 8000);
    clip.set(windowPcm(6), 16000);
    const r = clf.classifyClip(clip);
    expect(r.windows.length).toBe(9);
    expect(r.windows.filter((w) => w.gated).length).toBeGreaterThan(0);
    expect(r.used).toBe(r.windows.filter((w) => !w.gated).length);
    const sum = Array.from(r.probs!).reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThan(0.95);
    expect(sum).toBeLessThan(1.05);
    expect(r.quality === 'ok' || r.quality === 'noise').toBe(true);
    console.log(`10 s clip: ${r.used} windows in ${r.ms.toFixed(1)} ms -> ${r.best}`);
  });

  it('flags silent and short clips for re-recording', () => {
    expect(clf.classifyClip(new Int16Array(40000)).quality).toBe('silent');
    expect(clf.classifyClip(new Int16Array(4000)).quality).toBe('short');
  });

  it('rejects files that are not TFLite', () => {
    expect(() => new TfliteModel(new Uint8Array(64))).toThrow(/not a TFLite model/);
  });
});

describe('referral rules', () => {
  const lungOk = { RU: 'normal', LU: 'normal', RL: 'normal', LL: 'normal' } as const;

  it('uses the WHO fast-breathing threshold for each age band', () => {
    const cases: Array<[0 | 1 | 2 | 3, number, number]> = [[0, 60, 59], [1, 50, 49], [2, 40, 39], [3, 21, 20]];
    for (const [band, fast, notFast] of cases) {
      expect(evaluate({ ageBand: band, breathBpm: fast, lung: lungOk }).refer).toBe(true);
      expect(evaluate({ ageBand: band, breathBpm: notFast, lung: lungOk }).refer).toBe(false);
    }
  });

  it('refers on crackles or wheezes at any position', () => {
    const r = evaluate({ ageBand: 2, breathBpm: 30, lung: { ...lungOk, LL: 'wheezes', RU: 'crackles' } });
    expect(r.refer).toBe(true);
    expect(r.abnormalLung).toBe('crackles');
    expect(r.reasons).toHaveLength(2);
  });

  it('refers on low SpO2', () => {
    expect(evaluate({ ageBand: 2, breathBpm: 30, lung: lungOk, spo2: 89 }).refer).toBe(true);
    expect(evaluate({ ageBand: 2, breathBpm: 30, lung: lungOk, spo2: 90 }).refer).toBe(false);
  });

  it('reports missing steps; noise counts as missing', () => {
    const r = evaluate({ ageBand: 1, lung: { RU: 'normal', LU: 'noise' } });
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual(['breath', 'lung_LU', 'lung_RL', 'lung_LL']);
    expect(r.refer).toBe(false);
  });

  it('computes age bands from date of birth', () => {
    const at = new Date(2026, 10, 2);
    expect(ageBand(new Date(2026, 9, 1), at)).toBe(0);
    expect(ageBand(new Date(2026, 8, 2), at)).toBe(1);
    expect(ageBand(new Date(2025, 10, 2), at)).toBe(2);
    expect(ageBand(new Date(2021, 10, 3), at)).toBe(2);
    expect(ageBand(new Date(2021, 10, 2), at)).toBe(3);
    expect(() => ageBand(new Date(2027, 0, 1), at)).toThrow();
  });

  it('triages into normal, refer and danger', () => {
    expect(triage({ ageBand: 2, breathBpm: 30, lung: lungOk }).level).toBe('normal');
    expect(triage({ ageBand: 2, breathBpm: 45, lung: lungOk }).level).toBe('refer');
    expect(triage({ ageBand: 2, breathBpm: 30, lung: lungOk, bodyTempC: 38.2 }).level).toBe('refer');
    expect(triage({ ageBand: 2, breathBpm: 30, lung: lungOk, bodyTempC: 37.9 }).level).toBe('normal');
    expect(triage({ ageBand: 2, breathBpm: 30, lung: { ...lungOk, RL: 'crackles' }, bodyTempC: 38.5 }).level).toBe('danger');
    expect(triage({ ageBand: 2, breathBpm: 30, lung: lungOk, spo2: 88 }).level).toBe('danger');
    const d = triage({ ageBand: 1, breathBpm: 30, lung: lungOk, dangerSigns: ['chest_indrawing'] });
    expect(d.level).toBe('danger');
    expect(d.urgent[0]).toContain('indrawing');
  });

  it('has class names that match the model', () => {
    expect(MODEL.CLASS_NAMES).toEqual(['normal', 'crackles', 'wheezes', 'noise']);
  });
});
