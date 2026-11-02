// Minimal int8 TFLite interpreter for the PneumoScreen lung model.
// Kernels follow TFLite's reference integer kernels (reference_integer_ops)
// so results match TFLite/TFLM bit-for-bit, except SOFTMAX, which is computed
// in float from the dequantized logits (within 1 output step of TFLite).
import { root, Table } from './flatbuffer';

const Builtin = { CONV_2D: 3, FULLY_CONNECTED: 9, MAX_POOL_2D: 17, RESHAPE: 22, SOFTMAX: 25, REDUCE_MAX: 82 } as const;
const BUILTIN_NAMES: Record<number, string> = Object.fromEntries(Object.entries(Builtin).map(([k, v]) => [v, k]));
const TensorType = { FLOAT32: 0, INT32: 2, INT8: 9 } as const;
const Padding = { SAME: 0, VALID: 1 } as const;
const Act = { NONE: 0, RELU: 1, RELU_N1_TO_1: 2, RELU6: 3 } as const;

interface Quant { scale: Float32Array; zeroPoint: number[]; dim: number }
interface Tensor { name: string; shape: number[]; type: number; quant: Quant | null; data: Int8Array | Int32Array | null }
interface Op { code: number; inputs: Int32Array; outputs: Int32Array; options: Table | null }

// ── fixed-point helpers (tensorflow/lite/kernels/internal/common.h) ──

const INT32_MIN = -2147483648;
const B31 = 1n << 31n;
const NUDGE_POS = 1n << 30n;
const NUDGE_NEG = 1n - (1n << 30n);

export function saturatingRoundingDoublingHighMul(a: number, b: number): number {
  if (a === INT32_MIN && b === INT32_MIN) return 2147483647;
  const ab = BigInt(a) * BigInt(b);
  return Number((ab + (ab >= 0n ? NUDGE_POS : NUDGE_NEG)) / B31);
}

export function roundingDivideByPOT(x: number, exponent: number): number {
  if (exponent === 0) return x;
  const mask = (1 << exponent) - 1;
  const remainder = x & mask;
  const threshold = (mask >> 1) + (x < 0 ? 1 : 0);
  return (x >> exponent) + (remainder > threshold ? 1 : 0);
}

export function multiplyByQuantizedMultiplier(x: number, multiplier: number, shift: number): number {
  const left = shift > 0 ? shift : 0;
  const right = shift > 0 ? 0 : -shift;
  return roundingDivideByPOT(saturatingRoundingDoublingHighMul(Math.imul(x, 1 << left), multiplier), right);
}

/** QuantizeMultiplier(): real multiplier → (int32 q31, shift). */
export function quantizeMultiplier(m: number): [number, number] {
  if (m === 0) return [0, 0];
  let exp = Math.ceil(Math.log2(Math.abs(m)));
  let frac = m / 2 ** exp;
  while (Math.abs(frac) >= 1) { frac /= 2; exp++; }
  while (Math.abs(frac) < 0.5) { frac *= 2; exp--; }
  let q = Math.round(frac * 2 ** 31);
  if (q === 2 ** 31) { q /= 2; exp++; }
  if (exp < -31) return [0, 0];
  return [q, exp];
}

function activationRange(act: number, q: Quant): [number, number] {
  const s = q.scale[0];
  const zp = q.zeroPoint[0];
  const qz = (r: number): number => zp + Math.round(r / s);
  switch (act) {
    case Act.NONE: return [-128, 127];
    case Act.RELU: return [Math.max(-128, qz(0)), 127];
    case Act.RELU6: return [Math.max(-128, qz(0)), Math.min(127, qz(6))];
    case Act.RELU_N1_TO_1: return [Math.max(-128, qz(-1)), Math.min(127, qz(1))];
    default: throw new Error(`unsupported fused activation ${act}`);
  }
}

function padding(kind: number, inSize: number, filter: number, stride: number): { out: number; pad: number } {
  if (kind === Padding.SAME) {
    const out = Math.ceil(inSize / stride);
    return { out, pad: Math.floor(Math.max(0, (out - 1) * stride + filter - inSize) / 2) };
  }
  return { out: Math.floor((inSize - filter + stride) / stride), pad: 0 };
}

function perChannelMultipliers(inQ: Quant, wQ: Quant, outQ: Quant, n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let c = 0; c < n; c++) {
    const ws = wQ.scale.length > 1 ? wQ.scale[c] : wQ.scale[0];
    out.push(quantizeMultiplier((inQ.scale[0] * ws) / outQ.scale[0]));
  }
  return out;
}

// ── model ──

export class TfliteModel {
  readonly tensors: Tensor[];
  readonly ops: Op[];
  readonly inputs: number[];
  readonly outputs: number[];

  constructor(buf: Uint8Array) {
    const ident = new TextDecoder().decode(buf.subarray(4, 8));
    if (ident !== 'TFL3') throw new Error(`not a TFLite model (identifier "${ident}")`);
    const m = root(buf);
    const codes = m.tables(1).map((oc) => Math.max(oc.i8(0), oc.i32(3)));
    const buffers = m.tables(4);
    const subgraphs = m.tables(2);
    if (subgraphs.length !== 1) throw new Error(`expected 1 subgraph, got ${subgraphs.length}`);
    const g = subgraphs[0];

    this.tensors = g.tables(0).map((t) => {
      const type = t.u8(1);
      const qt = t.table(4);
      const scale = qt ? qt.f32s(2) : new Float32Array(0);
      const quant = scale.length ? { scale, zeroPoint: qt!.i64s(3), dim: qt!.i32(6) } : null;
      const raw = buffers[t.u32(2)]?.bytes(0) ?? new Uint8Array(0);
      let data: Int8Array | Int32Array | null = null;
      if (raw.length) {
        const copy = raw.slice();
        if (type === TensorType.INT8) data = new Int8Array(copy.buffer);
        else if (type === TensorType.INT32) data = new Int32Array(copy.buffer);
        else throw new Error(`unsupported constant tensor type ${type}`);
      }
      return { name: t.string(3), shape: Array.from(t.i32s(0)), type, quant, data };
    });
    this.inputs = Array.from(g.i32s(1));
    this.outputs = Array.from(g.i32s(2));
    this.ops = g.tables(3).map((o) => ({
      code: codes[o.u32(0)],
      inputs: o.i32s(1),
      outputs: o.i32s(2),
      options: o.table(4),
    }));
    for (const op of this.ops)
      if (!(op.code in BUILTIN_NAMES)) throw new Error(`unsupported TFLite op ${op.code}`);
    const inT = this.tensors[this.inputs[0]];
    if (inT.type !== TensorType.INT8 || !inT.quant) throw new Error('model input must be quantized int8');
  }

  get input(): Tensor { return this.tensors[this.inputs[0]]; }
  get output(): Tensor { return this.tensors[this.outputs[0]]; }
}

const size = (shape: number[]): number => shape.reduce((a, b) => a * b, 1);

export class Interpreter {
  private values = new Map<number, Int8Array | Int32Array>();

  constructor(readonly model: TfliteModel) {}

  private get(i: number): Int8Array | Int32Array {
    const t = this.model.tensors[i];
    const v = t.data ?? this.values.get(i);
    if (!v) throw new Error(`tensor ${i} (${t.name}) has no value`);
    return v;
  }

  tensor(i: number): Int8Array | Int32Array | undefined { return this.model.tensors[i].data ?? this.values.get(i); }

  /** Runs the model on one int8 input; returns the int8 output tensor. */
  invoke(input: Int8Array): Int8Array {
    const inT = this.model.input;
    if (input.length !== size(inT.shape)) throw new Error(`input: ${input.length} values, expected ${size(inT.shape)}`);
    this.values.clear();
    this.values.set(this.model.inputs[0], input);
    for (const op of this.model.ops) this.run(op);
    return this.get(this.model.outputs[0]) as Int8Array;
  }

  private run(op: Op): void {
    const T = this.model.tensors;
    const outIdx = op.outputs[0];
    const outT = T[outIdx];
    switch (op.code) {
      case Builtin.CONV_2D: this.values.set(outIdx, this.conv(op)); break;
      case Builtin.MAX_POOL_2D: this.values.set(outIdx, this.maxPool(op)); break;
      case Builtin.REDUCE_MAX: this.values.set(outIdx, this.reduceMax(op)); break;
      case Builtin.FULLY_CONNECTED: this.values.set(outIdx, this.fullyConnected(op)); break;
      case Builtin.SOFTMAX: this.values.set(outIdx, this.softmax(op)); break;
      case Builtin.RESHAPE: this.values.set(outIdx, this.get(op.inputs[0])); break;
      default: throw new Error(`unsupported op ${op.code}`);
    }
    if (this.values.get(outIdx)!.length !== size(outT.shape)) throw new Error(`op ${BUILTIN_NAMES[op.code]}: output size mismatch`);
  }

  private conv(op: Op): Int8Array {
    const T = this.model.tensors;
    const inT = T[op.inputs[0]], wT = T[op.inputs[1]], outT = T[op.outputs[0]];
    const x = this.get(op.inputs[0]) as Int8Array;
    const w = this.get(op.inputs[1]) as Int8Array;
    const bias = op.inputs.length > 2 && op.inputs[2] >= 0 ? (this.get(op.inputs[2]) as Int32Array) : null;
    const o = op.options!;
    const pad = o.u8(0), strideW = o.i32(1), strideH = o.i32(2), act = o.u8(3);
    const dilW = o.i32(4, 1), dilH = o.i32(5, 1);
    const [, inH, inW, inC] = inT.shape;
    const [outC, fH, fW, fC] = wT.shape;
    if (fC !== inC) throw new Error('conv: depth mismatch');
    const ph = padding(pad, inH, dilH * (fH - 1) + 1, strideH);
    const pw = padding(pad, inW, dilW * (fW - 1) + 1, strideW);
    const outH = outT.shape[1], outW = outT.shape[2];
    const inOff = -inT.quant!.zeroPoint[0];
    const outOff = outT.quant!.zeroPoint[0];
    const mult = perChannelMultipliers(inT.quant!, wT.quant!, outT.quant!, outC);
    const [lo, hi] = activationRange(act, outT.quant!);
    const y = new Int8Array(outH * outW * outC);
    for (let oy = 0; oy < outH; oy++) {
      const iy0 = oy * strideH - ph.pad;
      for (let ox = 0; ox < outW; ox++) {
        const ix0 = ox * strideW - pw.pad;
        for (let oc = 0; oc < outC; oc++) {
          let acc = 0;
          for (let fy = 0; fy < fH; fy++) {
            const iy = iy0 + dilH * fy;
            if (iy < 0 || iy >= inH) continue;
            for (let fx = 0; fx < fW; fx++) {
              const ix = ix0 + dilW * fx;
              if (ix < 0 || ix >= inW) continue;
              const xb = (iy * inW + ix) * inC;
              const wb = ((oc * fH + fy) * fW + fx) * fC;
              for (let ic = 0; ic < inC; ic++) acc += w[wb + ic] * (x[xb + ic] + inOff);
            }
          }
          if (bias) acc += bias[oc];
          let v = multiplyByQuantizedMultiplier(acc, mult[oc][0], mult[oc][1]) + outOff;
          if (v < lo) v = lo;
          if (v > hi) v = hi;
          y[(oy * outW + ox) * outC + oc] = v;
        }
      }
    }
    return y;
  }

  private maxPool(op: Op): Int8Array {
    const T = this.model.tensors;
    const inT = T[op.inputs[0]], outT = T[op.outputs[0]];
    const x = this.get(op.inputs[0]) as Int8Array;
    const o = op.options!;
    const pad = o.u8(0), strideW = o.i32(1), strideH = o.i32(2), fW = o.i32(3), fH = o.i32(4), act = o.u8(5);
    const [, inH, inW, C] = inT.shape;
    const ph = padding(pad, inH, fH, strideH), pw = padding(pad, inW, fW, strideW);
    const outH = outT.shape[1], outW = outT.shape[2];
    const [lo, hi] = activationRange(act, outT.quant!);
    const y = new Int8Array(outH * outW * C);
    for (let oy = 0; oy < outH; oy++) {
      const iy0 = oy * strideH - ph.pad;
      const fy0 = Math.max(0, -iy0), fy1 = Math.min(fH, inH - iy0);
      for (let ox = 0; ox < outW; ox++) {
        const ix0 = ox * strideW - pw.pad;
        const fx0 = Math.max(0, -ix0), fx1 = Math.min(fW, inW - ix0);
        for (let c = 0; c < C; c++) {
          let m = -128;
          for (let fy = fy0; fy < fy1; fy++)
            for (let fx = fx0; fx < fx1; fx++) {
              const v = x[((iy0 + fy) * inW + ix0 + fx) * C + c];
              if (v > m) m = v;
            }
          y[(oy * outW + ox) * C + c] = Math.min(hi, Math.max(lo, m));
        }
      }
    }
    return y;
  }

  private reduceMax(op: Op): Int8Array {
    const T = this.model.tensors;
    const inT = T[op.inputs[0]], outT = T[op.outputs[0]];
    const iq = inT.quant!, oq = outT.quant!;
    if (iq.scale[0] !== oq.scale[0] || iq.zeroPoint[0] !== oq.zeroPoint[0]) throw new Error('reduce_max: requantization not supported');
    const x = this.get(op.inputs[0]) as Int8Array;
    const axes = Array.from(this.get(op.inputs[1]) as Int32Array).map((a) => (a < 0 ? a + inT.shape.length : a));
    const shape = inT.shape;
    const keep = shape.map((_, i) => !axes.includes(i));
    const outShape = shape.map((d, i) => (keep[i] ? d : 1));
    const y = new Int8Array(size(outShape)).fill(-128);
    const strides = shape.map((_, i) => size(shape.slice(i + 1)));
    const outStrides = outShape.map((_, i) => size(outShape.slice(i + 1)));
    for (let i = 0; i < x.length; i++) {
      let oi = 0;
      for (let d = 0; d < shape.length; d++) {
        const coord = Math.floor(i / strides[d]) % shape[d];
        if (keep[d]) oi += coord * outStrides[d];
      }
      if (x[i] > y[oi]) y[oi] = x[i];
    }
    return y;
  }

  private fullyConnected(op: Op): Int8Array {
    const T = this.model.tensors;
    const inT = T[op.inputs[0]], wT = T[op.inputs[1]], outT = T[op.outputs[0]];
    const x = this.get(op.inputs[0]) as Int8Array;
    const w = this.get(op.inputs[1]) as Int8Array;
    const bias = op.inputs.length > 2 && op.inputs[2] >= 0 ? (this.get(op.inputs[2]) as Int32Array) : null;
    const act = op.options ? op.options.u8(0) : Act.NONE;
    const [outN, inN] = wT.shape;
    const batches = x.length / inN;
    const inOff = -inT.quant!.zeroPoint[0];
    const outOff = outT.quant!.zeroPoint[0];
    const mult = perChannelMultipliers(inT.quant!, wT.quant!, outT.quant!, outN);
    const [lo, hi] = activationRange(act, outT.quant!);
    const y = new Int8Array(batches * outN);
    for (let b = 0; b < batches; b++)
      for (let o = 0; o < outN; o++) {
        let acc = 0;
        for (let k = 0; k < inN; k++) acc += w[o * inN + k] * (x[b * inN + k] + inOff);
        if (bias) acc += bias[o];
        let v = multiplyByQuantizedMultiplier(acc, mult[o][0], mult[o][1]) + outOff;
        if (v < lo) v = lo;
        if (v > hi) v = hi;
        y[b * outN + o] = v;
      }
    return y;
  }

  private softmax(op: Op): Int8Array {
    const T = this.model.tensors;
    const inT = T[op.inputs[0]], outT = T[op.outputs[0]];
    const x = this.get(op.inputs[0]) as Int8Array;
    const beta = op.options ? op.options.f32(0, 1) : 1;
    const n = inT.shape[inT.shape.length - 1];
    const is = inT.quant!.scale[0], iz = inT.quant!.zeroPoint[0];
    const os = outT.quant!.scale[0], oz = outT.quant!.zeroPoint[0];
    const y = new Int8Array(x.length);
    for (let r = 0; r < x.length; r += n) {
      let max = -Infinity;
      for (let i = 0; i < n; i++) max = Math.max(max, (x[r + i] - iz) * is);
      let sum = 0;
      const e = new Float64Array(n);
      for (let i = 0; i < n; i++) { e[i] = Math.exp(beta * ((x[r + i] - iz) * is - max)); sum += e[i]; }
      for (let i = 0; i < n; i++) y[r + i] = Math.min(127, Math.max(-128, Math.round(e[i] / sum / os) + oz));
    }
    return y;
  }
}

export function dequantize(q: Int8Array, t: Tensor): Float32Array {
  const s = t.quant!.scale[0], z = t.quant!.zeroPoint[0];
  return Float32Array.from(q, (v) => (v - z) * s);
}
