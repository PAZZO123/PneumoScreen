// Validation, access control, conflict rules and change feed for the
// syncable tables. REST and /ws/sync both go through applyChange().
import { audit, currentRev, type DB, nextRev, now, tx } from './db.ts';
import type { Worker } from './auth.ts';
import {
  type ApplyResult, type Attempt, type Baby, type Change, SEXES, type ScreeningSession, type Step,
  STEP_STATUS, STEP_TYPES, type TableName,
} from './wire.ts';

export class Rejected extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function uuid(v: unknown, field: string): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new Rejected(`${field}: expected a UUID`);
  return v.toLowerCase();
}
function iso(v: unknown, field: string): string {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new Rejected(`${field}: expected an ISO-8601 time`);
  return new Date(v).toISOString();
}
function isoOpt(v: unknown, field: string): string | null {
  return v == null ? null : iso(v, field);
}
function text(v: unknown, field: string, max: number, required = false): string | null {
  if (v == null || v === '') {
    if (required) throw new Rejected(`${field}: required`);
    return null;
  }
  if (typeof v !== 'string') throw new Rejected(`${field}: expected text`);
  const s = v.trim();
  if (s.length > max) throw new Rejected(`${field}: longer than ${max} characters`);
  if (required && !s) throw new Rejected(`${field}: required`);
  return s;
}
function oneOf<T extends string>(v: unknown, list: readonly T[], field: string): T {
  if (!list.includes(v as T)) throw new Rejected(`${field}: expected one of ${list.join(', ')}`);
  return v as T;
}
function json(v: unknown, field: string, max = 64_000): string | null {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Rejected(`${field}: expected an object`);
  const s = JSON.stringify(v);
  if (s.length > max) throw new Rejected(`${field}: too large`);
  return s;
}

// ── access ──

export function babyIdOf(db: DB, table: TableName, id: string): string | null {
  switch (table) {
    case 'babies': return id;
    case 'sessions': return (db.prepare('SELECT baby_id FROM sessions WHERE id = ?').get(id) as { baby_id: string } | undefined)?.baby_id ?? null;
    case 'steps':
      return (db.prepare('SELECT s.baby_id FROM steps st JOIN sessions s ON s.id = st.session_id WHERE st.id = ?').get(id) as { baby_id: string } | undefined)?.baby_id ?? null;
    case 'attempts':
      return (db.prepare('SELECT s.baby_id FROM attempts a JOIN steps st ON st.id = a.step_id JOIN sessions s ON s.id = st.session_id WHERE a.id = ?').get(id) as { baby_id: string } | undefined)?.baby_id ?? null;
  }
}

export function canAccessBaby(db: DB, w: Worker, babyId: string): boolean {
  if (w.role === 'supervisor') return true;
  const b = db.prepare('SELECT created_by, assigned_to FROM babies WHERE id = ?').get(babyId) as { created_by: string; assigned_to: string | null } | undefined;
  return !!b && (b.created_by === w.id || b.assigned_to === w.id);
}

/** SQL fragment restricting babies (alias b) to those `w` may see. */
export function babyScope(w: Worker): { sql: string; args: string[] } {
  return w.role === 'supervisor' ? { sql: '1', args: [] } : { sql: '(b.created_by = ? OR b.assigned_to = ?)', args: [w.id, w.id] };
}

// ── row <-> record ──

type Row = Record<string, unknown>;

export function toRecord(table: TableName, r: Row): Change['record'] {
  switch (table) {
    case 'babies':
      return {
        id: r.id, name: r.name, date_of_birth: r.date_of_birth, sex: r.sex, guardian_name: r.guardian_name,
        guardian_phone: r.guardian_phone, village: r.village, notes: r.notes, assigned_to: r.assigned_to,
        created_by: r.created_by, updated_at: r.updated_at, deleted: !!r.deleted, rev: r.rev,
      } as Baby;
    case 'sessions':
      return {
        id: r.id, baby_id: r.baby_id, worker_id: r.worker_id, device_id: r.device_id, firmware_version: r.firmware_version,
        started_at: r.started_at, finished_at: r.finished_at, status: r.status,
        result: r.result ? JSON.parse(r.result as string) : null, updated_at: r.updated_at, deleted: !!r.deleted, rev: r.rev,
      } as ScreeningSession;
    case 'steps':
      return {
        id: r.id, session_id: r.session_id, type: r.type, required: !!r.required, status: r.status,
        accepted_attempt: r.accepted_attempt, updated_at: r.updated_at, deleted: !!r.deleted, rev: r.rev,
      } as Step;
    case 'attempts':
      return {
        id: r.id, step_id: r.step_id, n: r.n, values: JSON.parse(r.values as string), quality: r.quality,
        model_output: r.model_output ? JSON.parse(r.model_output as string) : null, recording_id: r.recording_id,
        created_at: r.created_at, rev: r.rev,
      } as Attempt;
  }
}

export function getRecord(db: DB, table: TableName, id: string): Change['record'] | null {
  const r = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Row | undefined;
  return r ? toRecord(table, r) : null;
}

// ── apply ──

/** Newer wins; on a tie the stored row is kept. */
function isNewer(incoming: string, stored: unknown): boolean {
  return Date.parse(incoming) > Date.parse(String(stored));
}

function recomputeSession(db: DB, sessionId: string): void {
  const s = db.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as { status: string } | undefined;
  if (!s) return;
  const c = db
    .prepare("SELECT COUNT(*) AS req, SUM(status = 'done') AS done FROM steps WHERE session_id = ? AND required = 1 AND deleted = 0")
    .get(sessionId) as { req: number; done: number | null };
  const status = c.req > 0 && (c.done ?? 0) === c.req ? 'complete' : 'incomplete';
  if (status !== s.status) db.prepare('UPDATE sessions SET status = ?, rev = ? WHERE id = ?').run(status, nextRev(db), sessionId);
}

function applyBaby(db: DB, w: Worker, rec: Baby): ApplyResult {
  const id = uuid(rec.id, 'id');
  const updated = iso(rec.updated_at, 'updated_at');
  const dob = text(rec.date_of_birth, 'date_of_birth', 10, true)!;
  if (!DATE.test(dob) || Number.isNaN(Date.parse(dob))) throw new Rejected('date_of_birth: expected YYYY-MM-DD');
  const v = {
    name: text(rec.name, 'name', 120, true),
    sex: oneOf(rec.sex, SEXES, 'sex'),
    guardian_name: text(rec.guardian_name, 'guardian_name', 120),
    guardian_phone: text(rec.guardian_phone, 'guardian_phone', 32),
    village: text(rec.village, 'village', 120),
    notes: text(rec.notes, 'notes', 2000),
    assigned_to: rec.assigned_to == null ? null : uuid(rec.assigned_to, 'assigned_to'),
  };
  if (v.assigned_to && !db.prepare('SELECT 1 FROM workers WHERE id = ?').get(v.assigned_to)) throw new Rejected('assigned_to: unknown worker');
  const cur = db.prepare('SELECT updated_at FROM babies WHERE id = ?').get(id) as Row | undefined;
  if (cur) {
    if (!canAccessBaby(db, w, id)) throw new Rejected('forbidden');
    if (!isNewer(updated, cur.updated_at)) return { table: 'babies', id, status: 'stale' };
    const rev = nextRev(db);
    db.prepare(
      `UPDATE babies SET name=?, date_of_birth=?, sex=?, guardian_name=?, guardian_phone=?, village=?, notes=?, assigned_to=?,
       updated_at=?, deleted=?, rev=? WHERE id=?`,
    ).run(v.name, dob, v.sex, v.guardian_name, v.guardian_phone, v.village, v.notes, v.assigned_to, updated, rec.deleted ? 1 : 0, rev, id);
    audit(db, w.id, 'update', 'baby', id);
    return { table: 'babies', id, status: 'applied', rev };
  }
  const rev = nextRev(db);
  db.prepare(
    `INSERT INTO babies (id, name, date_of_birth, sex, guardian_name, guardian_phone, village, notes, assigned_to, created_by, updated_at, deleted, rev)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, v.name, dob, v.sex, v.guardian_name, v.guardian_phone, v.village, v.notes, v.assigned_to, w.id, updated, rec.deleted ? 1 : 0, rev);
  audit(db, w.id, 'create', 'baby', id);
  return { table: 'babies', id, status: 'applied', rev };
}

function applySession(db: DB, w: Worker, rec: ScreeningSession): ApplyResult {
  const id = uuid(rec.id, 'id');
  const updated = iso(rec.updated_at, 'updated_at');
  const babyId = uuid(rec.baby_id, 'baby_id');
  if (!db.prepare('SELECT 1 FROM babies WHERE id = ?').get(babyId)) throw new Rejected('missing_parent: baby');
  if (!canAccessBaby(db, w, babyId)) throw new Rejected('forbidden');
  const v = {
    device_id: text(rec.device_id, 'device_id', 64),
    firmware_version: text(rec.firmware_version, 'firmware_version', 32),
    started_at: iso(rec.started_at, 'started_at'),
    finished_at: isoOpt(rec.finished_at, 'finished_at'),
    result: json(rec.result, 'result'),
  };
  const cur = db.prepare('SELECT updated_at, baby_id FROM sessions WHERE id = ?').get(id) as Row | undefined;
  let rev: number;
  if (cur) {
    if (cur.baby_id !== babyId) throw new Rejected('baby_id: cannot move a session to another baby');
    if (!isNewer(updated, cur.updated_at)) return { table: 'sessions', id, status: 'stale' };
    rev = nextRev(db);
    db.prepare('UPDATE sessions SET device_id=?, firmware_version=?, started_at=?, finished_at=?, result=?, updated_at=?, deleted=?, rev=? WHERE id=?')
      .run(v.device_id, v.firmware_version, v.started_at, v.finished_at, v.result, updated, rec.deleted ? 1 : 0, rev, id);
  } else {
    rev = nextRev(db);
    db.prepare(
      `INSERT INTO sessions (id, baby_id, worker_id, device_id, firmware_version, started_at, finished_at, status, result, updated_at, deleted, rev)
       VALUES (?,?,?,?,?,?,?,'incomplete',?,?,?,?)`,
    ).run(id, babyId, w.id, v.device_id, v.firmware_version, v.started_at, v.finished_at, v.result, updated, rec.deleted ? 1 : 0, rev);
  }
  if (v.device_id)
    db.prepare(
      `INSERT INTO devices (device_id, firmware_version, last_worker, last_seen) VALUES (?,?,?,?)
       ON CONFLICT(device_id) DO UPDATE SET firmware_version=excluded.firmware_version, last_worker=excluded.last_worker, last_seen=excluded.last_seen`,
    ).run(v.device_id, v.firmware_version, w.id, now());
  recomputeSession(db, id);
  return { table: 'sessions', id, status: 'applied', rev };
}

function applyStep(db: DB, w: Worker, rec: Step): ApplyResult {
  const id = uuid(rec.id, 'id');
  const updated = iso(rec.updated_at, 'updated_at');
  const sessionId = uuid(rec.session_id, 'session_id');
  const s = db.prepare('SELECT baby_id FROM sessions WHERE id = ?').get(sessionId) as { baby_id: string } | undefined;
  if (!s) throw new Rejected('missing_parent: session');
  if (!canAccessBaby(db, w, s.baby_id)) throw new Rejected('forbidden');
  const type = oneOf(rec.type, STEP_TYPES, 'type');
  const status = oneOf(rec.status, STEP_STATUS, 'status');
  if (typeof rec.required !== 'boolean') throw new Rejected('required: expected true or false');
  const accepted = rec.accepted_attempt == null ? null : uuid(rec.accepted_attempt, 'accepted_attempt');
  if (accepted) {
    const a = db.prepare('SELECT step_id FROM attempts WHERE id = ?').get(accepted) as { step_id: string } | undefined;
    if (a && a.step_id !== id) throw new Rejected('accepted_attempt: belongs to another step');
  }
  const cur = db.prepare('SELECT updated_at, session_id, type FROM steps WHERE id = ?').get(id) as Row | undefined;
  let rev: number;
  if (cur) {
    if (cur.session_id !== sessionId || cur.type !== type) throw new Rejected('session_id/type: cannot change');
    if (!isNewer(updated, cur.updated_at)) return { table: 'steps', id, status: 'stale' };
    rev = nextRev(db);
    db.prepare('UPDATE steps SET required=?, status=?, accepted_attempt=?, updated_at=?, deleted=?, rev=? WHERE id=?')
      .run(rec.required ? 1 : 0, status, accepted, updated, rec.deleted ? 1 : 0, rev, id);
  } else {
    if (db.prepare('SELECT 1 FROM steps WHERE session_id = ? AND type = ?').get(sessionId, type)) throw new Rejected(`duplicate_step: ${type} already exists in this session`);
    rev = nextRev(db);
    db.prepare('INSERT INTO steps (id, session_id, type, required, status, accepted_attempt, updated_at, deleted, rev) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, sessionId, type, rec.required ? 1 : 0, status, accepted, updated, rec.deleted ? 1 : 0, rev);
  }
  recomputeSession(db, sessionId);
  return { table: 'steps', id, status: 'applied', rev };
}

function applyAttempt(db: DB, w: Worker, rec: Attempt): ApplyResult {
  const id = uuid(rec.id, 'id');
  if (db.prepare('SELECT 1 FROM attempts WHERE id = ?').get(id)) return { table: 'attempts', id, status: 'duplicate' };
  const stepId = uuid(rec.step_id, 'step_id');
  const st = db.prepare('SELECT st.session_id, s.baby_id FROM steps st JOIN sessions s ON s.id = st.session_id WHERE st.id = ?').get(stepId) as
    | { session_id: string; baby_id: string }
    | undefined;
  if (!st) throw new Rejected('missing_parent: step');
  if (!canAccessBaby(db, w, st.baby_id)) throw new Rejected('forbidden');
  if (!Number.isInteger(rec.n) || rec.n < 1 || rec.n > 1000) throw new Rejected('n: expected a positive integer');
  const values = json(rec.values ?? {}, 'values');
  const modelOut = json(rec.model_output, 'model_output');
  const recording = rec.recording_id == null ? null : uuid(rec.recording_id, 'recording_id');
  const rev = nextRev(db);
  db.prepare(
    'INSERT INTO attempts (id, step_id, n, "values", quality, model_output, recording_id, created_at, received_at, rev) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(id, stepId, rec.n, values, text(rec.quality, 'quality', 32), modelOut, recording, iso(rec.created_at, 'created_at'), now(), rev);
  return { table: 'attempts', id, status: 'applied', rev };
}

export function applyChange(db: DB, w: Worker, change: Change): ApplyResult {
  const table = change?.table;
  const id = typeof change?.record?.id === 'string' ? change.record.id : '';
  try {
    return tx(db, () => {
      switch (table) {
        case 'babies': return applyBaby(db, w, change.record as Baby);
        case 'sessions': return applySession(db, w, change.record as ScreeningSession);
        case 'steps': return applyStep(db, w, change.record as Step);
        case 'attempts': return applyAttempt(db, w, change.record as Attempt);
        default: throw new Rejected('table: unknown');
      }
    });
  } catch (e) {
    if (e instanceof Rejected) return { table: table as TableName, id, status: 'rejected', error: e.message };
    throw e;
  }
}

// ── change feed ──

export function pull(db: DB, w: Worker, since: number, limit = 500): { changes: Change[]; cursor: number; more: boolean } {
  const lim = Math.min(Math.max(1, limit), 2000);
  const rows = db
    .prepare(
      `SELECT 'babies' AS t, id, rev FROM babies WHERE rev > ?1
       UNION ALL SELECT 'sessions', id, rev FROM sessions WHERE rev > ?1
       UNION ALL SELECT 'steps', id, rev FROM steps WHERE rev > ?1
       UNION ALL SELECT 'attempts', id, rev FROM attempts WHERE rev > ?1
       ORDER BY rev LIMIT ?2`,
    )
    .all(since, lim + 1) as Array<{ t: TableName; id: string; rev: number }>;
  const more = rows.length > lim;
  const page = rows.slice(0, lim);
  const changes: Change[] = [];
  const seenBabies = new Set<string>();
  for (const r of page) {
    const baby = babyIdOf(db, r.t, r.id);
    if (!baby || !canAccessBaby(db, w, baby)) continue;
    const record = getRecord(db, r.t, r.id);
    if (record) changes.push({ table: r.t, record } as Change);
    if (r.t === 'babies') seenBabies.add(r.id);
  }
  for (const b of seenBabies) audit(db, w.id, 'sync_read', 'baby', b);
  const cursor = more ? page[page.length - 1].rev : Math.max(since, page.at(-1)?.rev ?? since, currentRev(db));
  return { changes, cursor, more };
}
