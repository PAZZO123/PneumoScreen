// Extract the DSP tables and model constants the firmware compiles
// (firmware/pneumoscreen/dsp_tables.h, model.h) into JSON for the phone port.
// Usage: node scripts/extract_tables.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../', import.meta.url);
const fw = (f) => readFileSync(fileURLToPath(new URL(`firmware/pneumoscreen/${f}`, root)), 'utf8');

function defines(src) {
  const out = {};
  for (const m of src.matchAll(/^#define\s+(\w+)\s+(-?[\d.]+)\b/gm)) out[m[1]] = Number(m[2]);
  return out;
}

function array(src, name) {
  const m = src.match(new RegExp(`\\b${name}\\s*\\[[^\\]]*\\](?:\\s*\\[[^\\]]*\\])?\\s*=\\s*\\{([\\s\\S]*?)\\};`));
  if (!m) throw new Error(`array ${name} not found`);
  return m[1]
    .replace(/[{}]/g, ' ')
    .split(',')
    .map((s) => s.trim().replace(/f$/, ''))
    .filter(Boolean)
    .map(Number);
}

function scalar(src, name) {
  const m = src.match(new RegExp(`\\b${name}\\s*=\\s*(-?[\\d.eE+-]+)f?;`));
  if (!m) throw new Error(`scalar ${name} not found`);
  return Number(m[1]);
}

const t = fw('dsp_tables.h');
const d = defines(t);
const tables = {
  SR: d.DSP_SR, N_FFT: d.DSP_N_FFT, HOP: d.DSP_HOP, N_MELS: d.DSP_N_MELS, N_MFCC: d.DSP_N_MFCC,
  N_BINS: d.DSP_N_BINS, N_FRAMES: d.DSP_N_FRAMES, WIN_SAMPLES: d.DSP_WIN_SAMPLES,
  DECIM_FACTOR: d.DSP_DECIM_FACTOR, DECIM_NTAPS: d.DSP_DECIM_NTAPS, SRC_SR: d.DSP_SRC_SR,
  MEL_MAX_LEN: d.MEL_MAX_LEN,
  HANN: array(t, 'DSP_HANN'),
  TWIDDLE_RE: array(t, 'DSP_TWIDDLE_RE'),
  TWIDDLE_IM: array(t, 'DSP_TWIDDLE_IM'),
  MEL_START: array(t, 'MEL_START'),
  MEL_LEN: array(t, 'MEL_LEN'),
  MEL_COEFF: array(t, 'MEL_COEFF'),
  DCT: array(t, 'DSP_DCT'),
  DECIM_TAPS: array(t, 'DSP_DECIM_TAPS'),
};
const sizes = {
  HANN: tables.N_FFT, TWIDDLE_RE: tables.N_FFT / 2, TWIDDLE_IM: tables.N_FFT / 2,
  MEL_START: tables.N_MELS, MEL_LEN: tables.N_MELS, MEL_COEFF: tables.N_MELS * tables.MEL_MAX_LEN,
  DCT: tables.N_MFCC * tables.N_MELS, DECIM_TAPS: tables.DECIM_NTAPS,
};
for (const [k, n] of Object.entries(sizes))
  if (tables[k].length !== n) throw new Error(`${k}: ${tables[k].length} values, expected ${n}`);

const m = fw('model.h');
const md = defines(m);
const names = m.match(/CLASS_NAMES\[[^\]]*\]\s*=\s*\{([^}]*)\}/)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
const meta = {
  N_CLASSES: md.N_CLASSES, CLASS_NAMES: names,
  MFCC_MEAN: array(m, 'MFCC_MEAN'), MFCC_STD: array(m, 'MFCC_STD'),
  INPUT_SCALE: scalar(m, 'INPUT_SCALE'), INPUT_ZERO_POINT: scalar(m, 'INPUT_ZERO_POINT'),
  MODEL_BYTES: scalar(m, 'model_tflite_len'),
};
if (meta.CLASS_NAMES.length !== meta.N_CLASSES || meta.MFCC_MEAN.length !== tables.N_MFCC)
  throw new Error('model.h: unexpected sizes');

const outputs = {
  'src/generated/dsp_tables.json': JSON.stringify(tables) + '\n',
  'src/generated/model_meta.json': JSON.stringify(meta, null, 2) + '\n',
};
const check = process.argv.includes('--check');
let stale = false;
for (const [rel, text] of Object.entries(outputs)) {
  const path = fileURLToPath(new URL(`../${rel}`, import.meta.url));
  if (check) {
    let cur = '';
    try { cur = readFileSync(path, 'utf8'); } catch {}
    if (cur !== text) { console.error(`stale: ${rel} (run pnpm --filter @pneumo/dsp extract)`); stale = true; }
  } else {
    writeFileSync(path, text);
    console.log(`wrote ${rel}`);
  }
}
if (stale) process.exit(1);
