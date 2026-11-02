// Lung-sound classification of a recorded clip, the way the board's
// lung_update() did it: 2 s windows every 1 s, silence gate, average the
// dequantized model outputs over the windows that pass.
import { computeMfcc, quantizeInput } from './mfcc';
import { DSP, MODEL } from './tables';
import { dequantize, Interpreter, TfliteModel } from './tflite/interpreter';

export const SILENCE_RMS = 0.005;
export const HOP_SAMPLES = DSP.SR; // 1 s

export type LungClass = 'normal' | 'crackles' | 'wheezes' | 'noise';
/** ok: usable; silent: no window above the gate; short: under 2 s; noise: model says noise. */
export type ClipQuality = 'ok' | 'silent' | 'short' | 'noise';

export interface WindowResult { start: number; rms: number; gated: boolean; probs: Float32Array | null; best: LungClass | null }

export interface ClipResult {
  windows: WindowResult[];
  used: number;
  probs: Float32Array | null;
  best: LungClass | null;
  quality: ClipQuality;
  ms: number;
}

const argmax = (p: ArrayLike<number>): number => {
  let b = 0;
  for (let i = 1; i < p.length; i++) if (p[i] > p[b]) b = i;
  return b;
};

export class LungClassifier {
  private readonly interp: Interpreter;

  constructor(readonly model: TfliteModel) {
    const shape = model.input.shape;
    if (shape.join() !== `1,${DSP.N_MFCC},${DSP.N_FRAMES},1`) throw new Error(`unexpected model input shape ${shape}`);
    if (model.output.shape.join() !== `1,${MODEL.N_CLASSES}`) throw new Error(`unexpected model output shape ${model.output.shape}`);
    this.interp = new Interpreter(model);
  }

  static fromBytes(buf: ArrayBuffer | Uint8Array): LungClassifier {
    return new LungClassifier(new TfliteModel(buf instanceof Uint8Array ? buf : new Uint8Array(buf)));
  }

  /** Model output for one quantized input, dequantized to probabilities. */
  runQuantized(input: Int8Array): { raw: Int8Array; probs: Float32Array } {
    const raw = this.interp.invoke(input).slice();
    return { raw, probs: dequantize(raw, this.model.output) };
  }

  /** One 2 s window of 4 kHz float samples in [-1, 1). */
  classifyWindow(x: Float32Array): { probs: Float32Array; best: LungClass } {
    const { probs } = this.runQuantized(quantizeInput(computeMfcc(x)));
    return { probs, best: MODEL.CLASS_NAMES[argmax(probs)] as LungClass };
  }

  /** A recorded clip of 4 kHz int16 PCM, as the board sends it. */
  classifyClip(pcm: Int16Array, opts: { hop?: number; silenceRms?: number } = {}): ClipResult {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const hop = opts.hop ?? HOP_SAMPLES;
    const gate = opts.silenceRms ?? SILENCE_RMS;
    const N = DSP.WIN_SAMPLES;
    const windows: WindowResult[] = [];
    const sum = new Float64Array(MODEL.N_CLASSES);
    let used = 0;
    const x = new Float32Array(N);
    for (let start = 0; start + N <= pcm.length; start += hop) {
      let ss = 0;
      for (let i = 0; i < N; i++) {
        x[i] = pcm[start + i] / 32768;
        ss += x[i] * x[i];
      }
      const rms = Math.sqrt(ss / N);
      if (rms < gate) {
        windows.push({ start, rms, gated: true, probs: null, best: null });
        continue;
      }
      const w = this.classifyWindow(x);
      windows.push({ start, rms, gated: false, ...w });
      for (let c = 0; c < MODEL.N_CLASSES; c++) sum[c] += w.probs[c];
      used++;
    }
    const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    if (pcm.length < N) return { windows, used, probs: null, best: null, quality: 'short', ms };
    if (!used) return { windows, used, probs: null, best: null, quality: 'silent', ms };
    const probs = Float32Array.from(sum, (s) => s / used);
    const best = MODEL.CLASS_NAMES[argmax(probs)] as LungClass;
    return { windows, used, probs, best, quality: best === 'noise' ? 'noise' : 'ok', ms };
  }
}
