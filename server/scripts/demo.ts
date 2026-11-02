// Fill the database with demo screenings so the dashboard has something to show
// before the phone app exists. Run `seed` first: records belong to chw1.
// Everything goes through applyChange() and putChunk(), the same paths sync and
// upload use. Rerunning is a no-op once the demo babies exist.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Worker } from '../src/auth.ts';
import { openDb } from '../src/db.ts';
import { putChunk } from '../src/recordings.ts';
import { applyChange } from '../src/records.ts';
import type { Attempt, Baby, Change, StepType } from '../src/wire.ts';

const dataDir = process.env.PNEUMO_DATA_DIR ?? fileURLToPath(new URL('../data/', import.meta.url));
mkdirSync(dataDir, { recursive: true });
const db = openDb(join(dataDir, 'pneumoscreen.sqlite'));

const chw = db.prepare("SELECT id, username, name, role FROM workers WHERE username = 'chw1'").get() as Worker | undefined;
if (!chw) {
  console.error('no chw1 account: run `pnpm --filter @pneumo/server seed` first');
  process.exit(1);
}

/** Stable UUID from a name, so reruns address the same rows. */
const uid = (name: string): string => {
  const h = createHash('sha256').update(`pneumo-demo:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const DAY = 86_400_000;
const ago = (days: number, minutes = 0): string => new Date(Date.now() - days * DAY + minutes * 60_000).toISOString();

if (db.prepare('SELECT 1 FROM babies WHERE id = ?').get(uid('baby:amani'))) {
  console.log('demo data already present');
  process.exit(0);
}

function apply(change: Change): void {
  const r = applyChange(db, chw!, change);
  if (r.status === 'rejected') throw new Error(`${change.table} ${r.id}: ${r.error}`);
}

/** 3 s of 4 kHz int16: a low tone plus noise, with clicks when `crackles`. */
function recording(name: string, crackles: boolean): string {
  const id = uid(`rec:${name}`);
  const rate = 4000, n = rate * 3;
  const pcm = Buffer.alloc(n * 2);
  let seed = [...name].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const breath = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 1.5);   // 40 breaths/min envelope
    let v = breath * (0.25 * Math.sin(2 * Math.PI * 180 * t) + 0.15 * rnd()) + 0.02 * rnd();
    if (crackles && i % 1700 < 40) v += 0.6 * Math.exp(-(i % 1700) / 8) * (i % 2 ? 1 : -1);
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 12000))), i * 2);
  }
  const sha256 = createHash('sha256').update(pcm).digest('hex');
  const half = pcm.length / 2;   // two chunks, like a resumed upload
  putChunk(db, dataDir, chw!, id, 0, { total: pcm.length, sampleRate: rate, sha256 }, pcm.subarray(0, half));
  putChunk(db, dataDir, chw!, id, half, {}, pcm.subarray(half));
  return id;
}

const PROBS: Record<string, number[]> = {
  normal: [0.82, 0.08, 0.06, 0.04], crackles: [0.14, 0.71, 0.09, 0.06], wheezes: [0.12, 0.1, 0.72, 0.06], noise: [0.1, 0.06, 0.04, 0.8],
};
const LABELS = ['normal', 'crackles', 'wheezes', 'noise'];

interface StepPlan {
  type: StepType;
  /** One entry per attempt; the last one is accepted. Omit for a step not done yet. */
  attempts?: Array<{ values?: Record<string, unknown>; lung?: string; quality?: string }>;
  required?: boolean;
}

function visit(key: string, babyId: string, daysAgo: number, plan: StepPlan[], refer?: { refer: boolean; reasons: string[] }): void {
  const sid = uid(`session:${key}`);
  const started = ago(daysAgo);
  const done = plan.every((p) => p.required === false || p.attempts?.length);
  apply({ table: 'sessions', record: {
    id: sid, baby_id: babyId, device_id: 'PNEUMO-7F3A', firmware_version: 'gw-1.0.0', started_at: started,
    finished_at: done ? ago(daysAgo, 12) : null, updated_at: ago(daysAgo, 12),
    result: done && refer ? { ...refer, rules_version: 'rules-1' } : null,
  } });
  for (const p of plan) {
    const stid = uid(`step:${key}:${p.type}`);
    const attempts = p.attempts ?? [];
    apply({ table: 'steps', record: {
      id: stid, session_id: sid, type: p.type, required: p.required ?? true, status: 'pending', updated_at: ago(daysAgo, 1),
    } });
    let last: string | null = null;
    attempts.forEach((a, i) => {
      const id = uid(`attempt:${key}:${p.type}:${i}`);
      const rec: Attempt = { id, step_id: stid, n: i + 1, values: a.values ?? {}, quality: a.quality ?? 'good', created_at: ago(daysAgo, 2 + i) };
      if (a.lung) {
        rec.values = { class: a.lung };
        rec.model_output = { class: a.lung, probs: Object.fromEntries(LABELS.map((l, j) => [l, PROBS[a.lung!][j]])), windows: 9 };
        rec.recording_id = recording(`${key}:${p.type}:${i}`, a.lung === 'crackles');
      }
      apply({ table: 'attempts', record: rec });
      last = id;
    });
    const poor = attempts.at(-1)?.quality === 'poor';
    apply({ table: 'steps', record: {
      id: stid, session_id: sid, type: p.type, required: p.required ?? true,
      status: !attempts.length ? 'pending' : poor ? 'poor' : 'done', accepted_attempt: last, updated_at: ago(daysAgo, 10),
    } });
  }
}

const baby = (key: string, b: Omit<Baby, 'id' | 'updated_at'>): string => {
  const id = uid(`baby:${key}`);
  apply({ table: 'babies', record: { id, updated_at: ago(60), assigned_to: chw.id, ...b } });
  return id;
};
const full = (bpm: number, lung: [string, string, string, string], temp: number, spo2: number): StepPlan[] => [
  { type: 'breath', attempts: [{ values: { bpm } }] },
  { type: 'lung_RU', attempts: [{ lung: lung[0] }] },
  { type: 'lung_LU', attempts: [{ lung: lung[1] }] },
  { type: 'lung_RL', attempts: [{ lung: lung[2] }] },
  { type: 'lung_LL', attempts: [{ lung: lung[3] }] },
  { type: 'temp', required: false, attempts: [{ values: { celsius: temp } }] },
  { type: 'spo2', attempts: [{ values: { spo2 } }] },
];
const N4: [string, string, string, string] = ['normal', 'normal', 'normal', 'normal'];
const ok = { refer: false, reasons: [] };

// Amani: three visits, getting better after a referral.
const amani = baby('amani', { name: 'Amani Uwase', date_of_birth: ago(300).slice(0, 10), sex: 'female', guardian_name: 'Claudine Mukamana', guardian_phone: '+250780000101', village: 'Nyamata', notes: 'Demo record' });
visit('amani-1', amani, 21, full(58, ['crackles', 'normal', 'crackles', 'normal'], 37.9, 92), { refer: true, reasons: ['fast breathing for age (≥50/min)', 'crackles at RU, RL'] });
visit('amani-2', amani, 10, full(47, ['normal', 'normal', 'crackles', 'normal'], 37.2, 95), { refer: true, reasons: ['crackles at RL'] });
visit('amani-3', amani, 2, full(41, N4, 36.8, 98), ok);

// Jean: one normal visit with a re-recorded lung position (noise, then normal).
const jean = baby('jean', { name: 'Jean Habimana', date_of_birth: ago(500).slice(0, 10), sex: 'male', guardian_name: 'Eric Ndayisaba', guardian_phone: '+250780000102', village: 'Nyamata' });
const jeanPlan = full(36, N4, 36.6, 97);
jeanPlan[2] = { type: 'lung_LU', attempts: [{ lung: 'noise', quality: 'poor' }, { lung: 'normal' }] };
visit('jean-1', jean, 5, jeanPlan, ok);

// Keza: today's screening, stopped before lung LL and SpO₂: shows in Follow-up.
const keza = baby('keza', { name: 'Keza Iradukunda', date_of_birth: ago(120).slice(0, 10), sex: 'female', guardian_name: 'Aline Uwimana', guardian_phone: '+250780000103', village: 'Gashora' });
const kezaPlan = full(52, N4, 37.0, 0).map((p) => (p.type === 'lung_LL' || p.type === 'spo2' ? { type: p.type } : p));
visit('keza-1', keza, 0, kezaPlan);

// Ishimwe: registered, not screened yet.
baby('ishimwe', { name: 'Ishimwe Mugisha', date_of_birth: ago(40).slice(0, 10), sex: 'male', guardian_name: 'Grace Uwera', village: 'Gashora', notes: 'Born early; check next week' });

db.close();
console.log('demo data written: 4 babies, 5 screenings (1 incomplete), 20 recordings');
