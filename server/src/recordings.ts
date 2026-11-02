// Resumable PCM uploads → WAV files under <dataDir>/recordings/.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Worker } from './auth.ts';
import { audit, type DB, now } from './db.ts';
import { canAccessBaby } from './records.ts';

export const MAX_RECORDING_BYTES = 2 * 1024 * 1024;

export interface RecordingRow {
  id: string; created_by: string; sample_rate: number; bytes_total: number; bytes_received: number;
  sha256: string; state: 'partial' | 'complete'; path: string | null; created_at: string; completed_at: string | null;
}

export class UploadError extends Error {
  readonly code: number;
  readonly received?: number;
  constructor(message: string, code: number, received?: number) {
    super(message);
    this.code = code;
    this.received = received;
  }
}

export function wavHeader(bytes: number, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(bytes, 40);
  return h;
}

export function getRecording(db: DB, id: string): RecordingRow | null {
  return (db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as unknown as RecordingRow | undefined) ?? null;
}

/** Creator, supervisor, or anyone who can see a baby whose attempt uses it. */
export function canAccessRecording(db: DB, w: Worker, r: RecordingRow): boolean {
  if (w.role === 'supervisor' || r.created_by === w.id) return true;
  const rows = db
    .prepare('SELECT s.baby_id FROM attempts a JOIN steps st ON st.id = a.step_id JOIN sessions s ON s.id = st.session_id WHERE a.recording_id = ?')
    .all(r.id) as Array<{ baby_id: string }>;
  return rows.some((x) => canAccessBaby(db, w, x.baby_id));
}

export function putChunk(
  db: DB, dataDir: string, w: Worker, id: string, offset: number,
  meta: { total?: number; sampleRate?: number; sha256?: string }, chunk: Buffer,
): RecordingRow {
  const dir = join(dataDir, 'recordings');
  mkdirSync(dir, { recursive: true });
  let r = getRecording(db, id);
  if (!r) {
    const { total, sampleRate, sha256 } = meta;
    if (!total || total < 2 || total > MAX_RECORDING_BYTES || total % 2) throw new UploadError('x-total-bytes: expected an even byte count up to 2 MB', 400);
    if (!sampleRate || sampleRate < 1000 || sampleRate > 48000) throw new UploadError('x-sample-rate: expected 1000–48000', 400);
    if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) throw new UploadError('x-sha256: expected 64 hex digits', 400);
    db.prepare("INSERT INTO recordings (id, created_by, sample_rate, bytes_total, bytes_received, sha256, state, created_at) VALUES (?,?,?,?,0,?,'partial',?)")
      .run(id, w.id, sampleRate, total, sha256, now());
    r = getRecording(db, id)!;
  }
  if (r.created_by !== w.id) throw new UploadError('forbidden', 403);
  if (r.state === 'complete') throw new UploadError('already complete', 409, r.bytes_total);
  if (offset !== r.bytes_received) throw new UploadError(`offset ${offset} does not match received bytes`, 409, r.bytes_received);
  if (r.bytes_received + chunk.length > r.bytes_total) throw new UploadError('chunk runs past x-total-bytes', 400, r.bytes_received);

  const part = join(dir, `${id}.part`);
  if (offset === 0 && existsSync(part)) rmSync(part);
  appendFileSync(part, chunk);
  const received = r.bytes_received + chunk.length;
  db.prepare('UPDATE recordings SET bytes_received = ? WHERE id = ?').run(received, id);

  if (received === r.bytes_total) {
    const pcm = readFileSync(part);
    const digest = createHash('sha256').update(pcm).digest('hex');
    if (digest !== r.sha256) {
      rmSync(part);
      db.prepare('UPDATE recordings SET bytes_received = 0 WHERE id = ?').run(id);
      throw new UploadError('sha256 mismatch; upload restarted from 0', 422, 0);
    }
    const wav = join(dir, `${id}.wav`);
    writeFileSync(wav, Buffer.concat([wavHeader(pcm.length, r.sample_rate), pcm]));
    rmSync(part);
    db.prepare("UPDATE recordings SET state = 'complete', path = ?, completed_at = ? WHERE id = ?").run(wav, now(), id);
    audit(db, w.id, 'upload', 'recording', id);
  }
  return getRecording(db, id)!;
}
