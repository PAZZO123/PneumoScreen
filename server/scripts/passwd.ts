// Set a worker's password: pnpm --filter @pneumo/server passwd <username>
// Asks twice without echoing; signs the worker out everywhere.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/auth.ts';
import { openDb } from '../src/db.ts';

const username = process.argv[2];
if (!username) {
  console.error('usage: pnpm --filter @pneumo/server passwd <username>');
  process.exit(1);
}
const dataDir = process.env.PNEUMO_DATA_DIR ?? fileURLToPath(new URL('../data/', import.meta.url));
const db = openDb(join(dataDir, 'pneumoscreen.sqlite'));
const row = db.prepare('SELECT id FROM workers WHERE username = ?').get(username) as { id: string } | undefined;
if (!row) {
  console.error(`no worker called ${username}`);
  process.exit(1);
}

// Reads one line without echo; buffered, so piped input with several lines works too.
const pending: string[] = [];
let partial = '';
let waiting: ((line: string) => void) | null = null;
function feed(d: Buffer): void {
  for (const c of d.toString('utf8')) {
    if (c === '\u0003') process.exit(130);
    if (c === '\r' || c === '\n') { pending.push(partial); partial = ''; }
    else if (c === '\u007f') partial = partial.slice(0, -1);
    else partial += c;
  }
  if (waiting && pending.length) { const w = waiting; waiting = null; w(pending.shift()!); }
}
function ask(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('data', feed).resume();
  return new Promise<string>((resolve) => {
    const done = (line: string) => {
      process.stdin.off('data', feed).pause();
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdout.write('\n');
      resolve(line);
    };
    if (pending.length) done(pending.shift()!); else waiting = done;
  });
}

const pw = await ask(`New password for ${username}: `);
if (pw.length < 8) {
  console.error('use at least 8 characters');
  process.exit(1);
}
if ((await ask('Type it again: ')) !== pw) {
  console.error('the two passwords differ; nothing changed');
  process.exit(1);
}
db.prepare('UPDATE workers SET pw_hash = ? WHERE id = ?').run(hashPassword(pw), row.id);
db.prepare('DELETE FROM auth_tokens WHERE worker_id = ?').run(row.id);
db.close();
console.log(`password changed for ${username} (server/.env.local still lists the old one)`);
