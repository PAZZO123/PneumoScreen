import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { type DB, now } from './db.ts';
import type { Role } from './wire.ts';

export interface Worker { id: string; username: string; name: string; role: Role }

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;
const TOKEN_TTL_MS = 12 * 3600 * 1000;

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [kind, n, salt, key] = stored.split('$');
  if (kind !== 'scrypt') return false;
  const want = Buffer.from(key, 'base64');
  const got = scryptSync(pw, Buffer.from(salt, 'base64'), want.length, { N: Number(n), r: SCRYPT.r, p: SCRYPT.p });
  return timingSafeEqual(want, got);
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export function createWorker(db: DB, w: { username: string; name: string; password: string; role: Role }): Worker {
  const id = randomUUID();
  db.prepare('INSERT INTO workers (id, username, name, pw_hash, role, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .run(id, w.username, w.name, hashPassword(w.password), w.role, now());
  return { id, username: w.username, name: w.name, role: w.role };
}

// ── account management (supervisors) ──
export const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const MIN_PASSWORD = 8;

export interface WorkerRow extends Worker { active: boolean; created_at: string; sessions: number; babies: number; last_login: string | null }

export function listWorkers(db: DB): WorkerRow[] {
  return (db.prepare(
    `SELECT w.id, w.username, w.name, w.role, w.active, w.created_at,
            (SELECT COUNT(*) FROM sessions s WHERE s.worker_id = w.id AND s.deleted = 0) AS sessions,
            (SELECT COUNT(*) FROM babies b WHERE b.deleted = 0 AND COALESCE(b.assigned_to, b.created_by) = w.id) AS babies,
            (SELECT MAX(at) FROM audit_log a WHERE a.worker_id = w.id AND a.action = 'login') AS last_login
     FROM workers w ORDER BY w.active DESC, w.role DESC, w.name`,
  ).all() as Array<Record<string, unknown>>).map((r) => ({ ...r, active: !!r.active } as WorkerRow));
}

/** Name, role or active; turning an account off signs it out everywhere. */
export function updateWorker(db: DB, id: string, p: { name?: string; role?: Role; active?: boolean }): void {
  if (p.name !== undefined) db.prepare('UPDATE workers SET name = ? WHERE id = ?').run(p.name, id);
  if (p.role !== undefined) db.prepare('UPDATE workers SET role = ? WHERE id = ?').run(p.role, id);
  if (p.active !== undefined) {
    db.prepare('UPDATE workers SET active = ? WHERE id = ?').run(p.active ? 1 : 0, id);
    if (!p.active) db.prepare('DELETE FROM auth_tokens WHERE worker_id = ?').run(id);
  }
}

/** New password; every session of that account is signed out. */
export function setPassword(db: DB, id: string, password: string): void {
  db.prepare('UPDATE workers SET pw_hash = ? WHERE id = ?').run(hashPassword(password), id);
  db.prepare('DELETE FROM auth_tokens WHERE worker_id = ?').run(id);
}

// Simple per-username login throttle: 10 failures per 5 minutes.
const failures = new Map<string, number[]>();
const WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILS = 10;

export function login(db: DB, username: string, password: string): { token: string; worker: Worker; expires_at: string } | 'throttled' | null {
  // Usernames are stored lowercase; phones capitalise the first letter and autofill adds spaces.
  const key = username.trim().toLowerCase();
  const recent = (failures.get(key) ?? []).filter((t) => Date.now() - t < WINDOW_MS);
  if (recent.length >= MAX_FAILS) return 'throttled';
  const row = db.prepare('SELECT id, username, name, role, pw_hash, active FROM workers WHERE lower(username) = ?').get(key) as
    | (Worker & { pw_hash: string; active: number })
    | undefined;
  if (!row || !row.active || !verifyPassword(password, row.pw_hash)) {
    recent.push(Date.now());
    failures.set(key, recent);
    return null;
  }
  failures.delete(key);
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  db.prepare('INSERT INTO auth_tokens (token_hash, worker_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), row.id, now(), expires);
  db.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').run(now());
  return { token, worker: { id: row.id, username: row.username, name: row.name, role: row.role }, expires_at: expires };
}

export function workerForToken(db: DB, token: string | undefined | null): Worker | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT w.id, w.username, w.name, w.role FROM auth_tokens t JOIN workers w ON w.id = t.worker_id
       WHERE t.token_hash = ? AND t.expires_at > ? AND w.active = 1`,
    )
    .get(sha256(token), now()) as Worker | undefined;
  return row ?? null;
}

export function logout(db: DB, token: string): void {
  db.prepare('DELETE FROM auth_tokens WHERE token_hash = ?').run(sha256(token));
}

export function resetLoginThrottle(): void {
  failures.clear();
}
