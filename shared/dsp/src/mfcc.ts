// Port of firmware/pneumoscreen/mfcc.cpp. Every float operation is rounded
// to float32 (Math.fround) in the same order as the C++ so features match.
import { DSP, MODEL } from './tables';

const fr = Math.fround;

/** 16 kHz int16 → 4 kHz float, 63-tap FIR (Decimator in mfcc.cpp). */
export class Decimator {
  private history = new Float32Array(64);
  private phase = 0;

  reset(): void {
    this.history.fill(0);
    this.phase = 0;
  }

  /** Returns the 4 kHz samples produced by `input`. */
  process(input: Int16Array): Float32Array {
    const out = new Float32Array(Math.floor((input.length + this.phase) / DSP.DECIM_FACTOR) + 1);
    const h = this.history;
    const taps = DSP.DECIM_TAPS;
    let n = 0;
    for (let i = 0; i < input.length; i++) {
      for (let t = DSP.DECIM_NTAPS - 1; t > 0; t--) h[t] = h[t - 1];
      h[0] = input[i] / 32768;
      if (++this.phase >= DSP.DECIM_FACTOR) {
        this.phase = 0;
        let acc = 0;
        for (let t = 0; t < DSP.DECIM_NTAPS; t++) acc = fr(acc + fr(taps[t] * h[t]));
        out[n++] = acc;
      }
    }
    return out.subarray(0, n);
  }
}

/** In-place 128-point radix-2 DIT FFT (fft128 in mfcc.cpp). */
export function fft128(re: Float32Array, im: Float32Array): void {
  const N = DSP.N_FFT;
  for (let i = 0; i < N; i++) {
    let j = 0;
    let x = i;
    for (let b = 0; b < 7; b++) { j = (j << 1) | (x & 1); x >>= 1; }
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let s = 1; s <= 7; s++) {
    const m = 1 << s;
    const half = m >> 1;
    const step = N / m;
    for (let k = 0; k < N; k += m) {
      for (let j = 0; j < half; j++) {
        const wr = DSP.TWIDDLE_RE[j * step];
        const wi = DSP.TWIDDLE_IM[j * step];
        const u = k + j;
        const v = u + half;
        const tr = fr(fr(wr * re[v]) - fr(wi * im[v]));
        const ti = fr(fr(wr * im[v]) + fr(wi * re[v]));
        re[v] = fr(re[u] - tr);
        im[v] = fr(im[u] - ti);
        re[u] = fr(re[u] + tr);
        im[u] = fr(im[u] + ti);
      }
    }
  }
}

const allLogMel = new Float32Array(DSP.N_FRAMES * DSP.N_MELS);
const frameRe = new Float32Array(DSP.N_FFT);
const frameIm = new Float32Array(DSP.N_FFT);
const power = new Float32Array(DSP.N_BINS);
const FLOOR_E = fr(1e-10);
const EPS = fr(1e-6);

/**
 * 13 x 124 MFCCs from one 2 s window (8000 samples @ 4 kHz), row-major
 * [coeff][frame] like compute_mfcc() and train.py.
 */
export function computeMfcc(x: Float32Array): Float32Array {
  const N = DSP.WIN_SAMPLES;
  if (x.length < N) throw new Error(`computeMfcc: need ${N} samples, got ${x.length}`);
  let mean = 0;
  for (let i = 0; i < N; i++) mean = fr(mean + x[i]);
  mean = fr(mean / N);
  let rms = 0;
  for (let i = 0; i < N; i++) {
    const d = fr(x[i] - mean);
    rms = fr(rms + fr(d * d));
  }
  rms = fr(fr(Math.sqrt(fr(rms / N))) + EPS);

  let globalMax = -1e30;
  for (let f = 0; f < DSP.N_FRAMES; f++) {
    const off = f * DSP.HOP;
    for (let i = 0; i < DSP.N_FFT; i++) {
      frameRe[i] = fr(fr(fr(x[off + i] - mean) / rms) * DSP.HANN[i]);
      frameIm[i] = 0;
    }
    fft128(frameRe, frameIm);
    for (let k = 0; k < DSP.N_BINS; k++)
      power[k] = fr(fr(frameRe[k] * frameRe[k]) + fr(frameIm[k] * frameIm[k]));
    for (let m = 0; m < DSP.N_MELS; m++) {
      let e = 0;
      const s = DSP.MEL_START[m];
      const base = m * DSP.MEL_MAX_LEN;
      for (let j = 0; j < DSP.MEL_LEN[m]; j++) e = fr(e + fr(DSP.MEL_COEFF[base + j] * power[s + j]));
      const v = e < FLOOR_E ? FLOOR_E : e;
      const lm = fr(10 * fr(Math.log10(v)));
      allLogMel[f * DSP.N_MELS + m] = lm;
      if (lm > globalMax) globalMax = lm;
    }
  }

  const floor = fr(globalMax - 80);
  for (let i = 0; i < allLogMel.length; i++) if (allLogMel[i] < floor) allLogMel[i] = floor;

  const out = new Float32Array(DSP.N_MFCC * DSP.N_FRAMES);
  for (let f = 0; f < DSP.N_FRAMES; f++) {
    for (let k = 0; k < DSP.N_MFCC; k++) {
      let acc = 0;
      for (let m = 0; m < DSP.N_MELS; m++) acc = fr(acc + fr(DSP.DCT[k * DSP.N_MELS + m] * allLogMel[f * DSP.N_MELS + m]));
      out[k * DSP.N_FRAMES + f] = acc;
    }
  }
  return out;
}

/** C roundf(): halves away from zero (Math.round sends -2.5 to -2). */
export const roundAway = (x: number): number => (x < 0 ? -Math.round(-x) : Math.round(x));

/** Per-coefficient z-score + int8 affine quantisation (quantize_input in mfcc.cpp). */
export function quantizeInput(mfcc: Float32Array): Int8Array {
  const out = new Int8Array(DSP.N_MFCC * DSP.N_FRAMES);
  for (let k = 0; k < DSP.N_MFCC; k++) {
    for (let f = 0; f < DSP.N_FRAMES; f++) {
      const i = k * DSP.N_FRAMES + f;
      const normed = fr(fr(mfcc[i] - MODEL.MFCC_MEAN[k]) / MODEL.MFCC_STD[k]);
      let q = roundAway(fr(normed / MODEL.INPUT_SCALE)) + MODEL.INPUT_ZERO_POINT;
      if (q < -128) q = -128;
      if (q > 127) q = 127;
      out[i] = q;
    }
  }
  return out;
}
