// DSP tables and model constants, extracted from the firmware headers by
// scripts/extract_tables.mjs and rounded to float32 like the C compiler does.
import raw from './generated/dsp_tables.json';
import meta from './generated/model_meta.json';

const f32 = (a: number[]): Float32Array => Float32Array.from(a);

export const DSP = {
  SR: raw.SR,
  N_FFT: raw.N_FFT,
  HOP: raw.HOP,
  N_MELS: raw.N_MELS,
  N_MFCC: raw.N_MFCC,
  N_BINS: raw.N_BINS,
  N_FRAMES: raw.N_FRAMES,
  WIN_SAMPLES: raw.WIN_SAMPLES,
  DECIM_FACTOR: raw.DECIM_FACTOR,
  DECIM_NTAPS: raw.DECIM_NTAPS,
  SRC_SR: raw.SRC_SR,
  MEL_MAX_LEN: raw.MEL_MAX_LEN,
  HANN: f32(raw.HANN),
  TWIDDLE_RE: f32(raw.TWIDDLE_RE),
  TWIDDLE_IM: f32(raw.TWIDDLE_IM),
  MEL_START: Int32Array.from(raw.MEL_START),
  MEL_LEN: Int32Array.from(raw.MEL_LEN),
  MEL_COEFF: f32(raw.MEL_COEFF),
  DCT: f32(raw.DCT),
  DECIM_TAPS: f32(raw.DECIM_TAPS),
} as const;

export const MODEL = {
  N_CLASSES: meta.N_CLASSES,
  CLASS_NAMES: meta.CLASS_NAMES as readonly string[],
  MFCC_MEAN: f32(meta.MFCC_MEAN),
  MFCC_STD: f32(meta.MFCC_STD),
  INPUT_SCALE: Math.fround(meta.INPUT_SCALE),
  INPUT_ZERO_POINT: meta.INPUT_ZERO_POINT,
} as const;
