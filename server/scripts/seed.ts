// Create a supervisor and a health-worker account with random passwords.
// Passwords go to server/.env.local (git-ignored), never to the console.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorker } from '../src/auth.ts';
import { openDb } from '../src/db.ts';

const dataDir = process.env.PNEUMO_DATA_DIR ?? fileURLToPath(new URL('../data/', import.meta.url));
// A custom data dir gets its own password file, so a test database never overwrites the real one.
const envPath = process.env.PNEUMO_DATA_DIR ? join(dataDir, '.env.local') : fileURLToPath(new URL('../.env.local', import.meta.url));
mkdirSync(dataDir, { recursive: true });
const db = openDb(join(dataDir, 'pneumoscreen.sqlite'));

const accounts = [
  { username: 'supervisor', name: 'Supervisor', role: 'supervisor' as const },
  { username: 'chw1', name: 'Health worker 1', role: 'worker' as const },
];
const lines = ['# PneumoScreen demo accounts — keep private, do not commit'];
for (const a of accounts) {
  if (db.prepare('SELECT 1 FROM workers WHERE username = ?').get(a.username)) {
    console.log(`exists: ${a.username}`);
    continue;
  }
  const password = randomBytes(12).toString('base64url');
  createWorker(db, { ...a, password });
  lines.push(`${a.username.toUpperCase()}_USERNAME=${a.username}`, `${a.username.toUpperCase()}_PASSWORD=${password}`);
  console.log(`created: ${a.username} (${a.role})`);
}
db.close();
if (lines.length > 1) {
  // Replace this account's old entries (a recreated database makes them stale).
  const fresh = new Set(lines.slice(1).map((l) => l.split('=')[0]));
  const kept = existsSync(envPath) ? readFileSync(envPath, 'utf8').split('\n').filter((l) => l && !fresh.has(l.split('=')[0]) && !l.startsWith('#')) : [];
  writeFileSync(envPath, [lines[0], ...kept, ...lines.slice(1)].join('\n') + '\n', { mode: 0o600 });
  console.log(`passwords written to ${envPath}`);
}
