// Minimal read-only FlatBuffers access, enough for the TFLite schema.
// https://flatbuffers.dev/flatbuffers_internals.html

export class Table {
  constructor(readonly bb: DataView, readonly pos: number) {}

  private fieldOffset(id: number): number {
    const vtable = this.pos - this.bb.getInt32(this.pos, true);
    const vtSize = this.bb.getUint16(vtable, true);
    const slot = 4 + id * 2;
    return slot < vtSize ? this.bb.getUint16(vtable + slot, true) : 0;
  }

  has(id: number): boolean { return this.fieldOffset(id) !== 0; }

  u8(id: number, def = 0): number { const o = this.fieldOffset(id); return o ? this.bb.getUint8(this.pos + o) : def; }
  i8(id: number, def = 0): number { const o = this.fieldOffset(id); return o ? this.bb.getInt8(this.pos + o) : def; }
  i32(id: number, def = 0): number { const o = this.fieldOffset(id); return o ? this.bb.getInt32(this.pos + o, true) : def; }
  u32(id: number, def = 0): number { const o = this.fieldOffset(id); return o ? this.bb.getUint32(this.pos + o, true) : def; }
  f32(id: number, def = 0): number { const o = this.fieldOffset(id); return o ? this.bb.getFloat32(this.pos + o, true) : def; }
  bool(id: number, def = false): boolean { const o = this.fieldOffset(id); return o ? this.bb.getUint8(this.pos + o) !== 0 : def; }

  private indirect(id: number): number | null {
    const o = this.fieldOffset(id);
    if (!o) return null;
    const at = this.pos + o;
    return at + this.bb.getUint32(at, true);
  }

  table(id: number): Table | null {
    const p = this.indirect(id);
    return p === null ? null : new Table(this.bb, p);
  }

  string(id: number): string {
    const p = this.indirect(id);
    if (p === null) return '';
    const len = this.bb.getUint32(p, true);
    return new TextDecoder().decode(new Uint8Array(this.bb.buffer, this.bb.byteOffset + p + 4, len));
  }

  private vector(id: number): { start: number; len: number } | null {
    const p = this.indirect(id);
    return p === null ? null : { start: p + 4, len: this.bb.getUint32(p, true) };
  }

  tables(id: number): Table[] {
    const v = this.vector(id);
    if (!v) return [];
    const out: Table[] = [];
    for (let i = 0; i < v.len; i++) {
      const at = v.start + i * 4;
      out.push(new Table(this.bb, at + this.bb.getUint32(at, true)));
    }
    return out;
  }

  i32s(id: number): Int32Array {
    const v = this.vector(id);
    const out = new Int32Array(v?.len ?? 0);
    for (let i = 0; v && i < v.len; i++) out[i] = this.bb.getInt32(v.start + i * 4, true);
    return out;
  }

  f32s(id: number): Float32Array {
    const v = this.vector(id);
    const out = new Float32Array(v?.len ?? 0);
    for (let i = 0; v && i < v.len; i++) out[i] = this.bb.getFloat32(v.start + i * 4, true);
    return out;
  }

  /** int64 vector as numbers (TFLite zero points always fit). */
  i64s(id: number): number[] {
    const v = this.vector(id);
    const out: number[] = [];
    for (let i = 0; v && i < v.len; i++) out.push(Number(this.bb.getBigInt64(v.start + i * 8, true)));
    return out;
  }

  bytes(id: number): Uint8Array {
    const v = this.vector(id);
    return v ? new Uint8Array(this.bb.buffer, this.bb.byteOffset + v.start, v.len) : new Uint8Array(0);
  }
}

export function root(buf: Uint8Array): Table {
  const bb = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return new Table(bb, bb.getUint32(0, true));
}
