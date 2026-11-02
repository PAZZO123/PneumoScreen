import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE workers (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    pw_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('worker','supervisor')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE auth_tokens (
    token_hash TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL REFERENCES workers(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO meta VALUES ('rev', '0');

  CREATE TABLE babies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    date_of_birth TEXT NOT NULL,
    sex TEXT NOT NULL,
    guardian_name TEXT, guardian_phone TEXT, village TEXT, notes TEXT,
    assigned_to TEXT REFERENCES workers(id),
    created_by TEXT NOT NULL REFERENCES workers(id),
    updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    rev INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    baby_id TEXT NOT NULL REFERENCES babies(id),
    worker_id TEXT NOT NULL REFERENCES workers(id),
    device_id TEXT, firmware_version TEXT,
    started_at TEXT NOT NULL, finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'incomplete',
    result TEXT,
    updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    rev INTEGER NOT NULL
  );
  CREATE TABLE steps (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    type TEXT NOT NULL,
    required INTEGER NOT NULL,
    status TEXT NOT NULL,
    accepted_attempt TEXT,
    updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    rev INTEGER NOT NULL,
    UNIQUE (session_id, type)
  );
  CREATE TABLE recordings (
    id TEXT PRIMARY KEY,
    created_by TEXT NOT NULL REFERENCES workers(id),
    sample_rate INTEGER NOT NULL,
    bytes_total INTEGER NOT NULL,
    bytes_received INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('partial','complete')),
    path TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE TABLE attempts (
    id TEXT PRIMARY KEY,
    step_id TEXT NOT NULL REFERENCES steps(id),
    n INTEGER NOT NULL,
    "values" TEXT NOT NULL,
    quality TEXT,
    model_output TEXT,
    recording_id TEXT,   -- the upload may arrive after the attempt syncs
    created_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    rev INTEGER NOT NULL
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    worker_id TEXT,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT
  );
  CREATE TABLE devices (
    device_id TEXT PRIMARY KEY,
    firmware_version TEXT,
    last_worker TEXT,
    last_seen TEXT NOT NULL
  );
  CREATE INDEX babies_rev ON babies(rev);
  CREATE INDEX sessions_rev ON sessions(rev);
  CREATE INDEX sessions_baby ON sessions(baby_id);
  CREATE INDEX steps_rev ON steps(rev);
  CREATE INDEX steps_session ON steps(session_id);
  CREATE INDEX attempts_rev ON attempts(rev);
  CREATE INDEX attempts_step ON attempts(step_id);
  `,
];

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)');
  const row = db.prepare('SELECT v FROM schema_version').get() as { v: number } | undefined;
  let v = row?.v ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (v) VALUES (0)').run();
  for (; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.prepare('UPDATE schema_version SET v = ?').run(v + 1);
    });
  }
  return db;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Next global revision number (call inside a transaction). */
export function nextRev(db: DB): number {
  db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev'").run();
  return Number((db.prepare("SELECT value FROM meta WHERE key = 'rev'").get() as { value: string }).value);
}

export function currentRev(db: DB): number {
  return Number((db.prepare("SELECT value FROM meta WHERE key = 'rev'").get() as { value: string }).value);
}

export const now = (): string => new Date().toISOString();

export function audit(db: DB, workerId: string | null, action: string, entity: string, entityId: string | null): void {
  db.prepare('INSERT INTO audit_log (at, worker_id, action, entity, entity_id) VALUES (?, ?, ?, ?, ?)').run(now(), workerId, action, entity, entityId);
}
