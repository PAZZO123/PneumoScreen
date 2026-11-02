import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { createWorker, resetLoginThrottle } from '../src/auth.ts';
import { buildServer } from '../src/server.ts';
import type { Attempt, Baby, ScreeningSession, Step, StepType } from '../src/wire.ts';

export interface Ctx {
  app: FastifyInstance;
  dataDir: string;
  tokens: { sup: string; a: string; b: string };
  ids: { sup: string; a: string; b: string };
  close: () => Promise<void>;
}

export async function setup(): Promise<Ctx> {
  resetLoginThrottle();
  const dataDir = mkdtempSync(join(tmpdir(), 'pneumo-test-'));
  const { app, db } = await buildServer({ dbPath: ':memory:', dataDir });
  const accounts = {
    sup: createWorker(db, { username: 'sup', name: 'Sup', password: 'sup-pass-123', role: 'supervisor' }),
    a: createWorker(db, { username: 'alice', name: 'Alice', password: 'alice-pass-123', role: 'worker' }),
    b: createWorker(db, { username: 'bob', name: 'Bob', password: 'bob-pass-123', role: 'worker' }),
  };
  const tok = async (username: string, password: string): Promise<string> =>
    (await app.inject({ method: 'POST', url: '/api/login', payload: { username, password } })).json().token;
  const tokens = { sup: await tok('sup', 'sup-pass-123'), a: await tok('alice', 'alice-pass-123'), b: await tok('bob', 'bob-pass-123') };
  return {
    app, dataDir, tokens,
    ids: { sup: accounts.sup.id, a: accounts.a.id, b: accounts.b.id },
    close: async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); },
  };
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });
export const at = (offsetMs = 0): string => new Date(Date.UTC(2026, 10, 2, 9) + offsetMs).toISOString();

export const baby = (o: Partial<Baby> = {}): Baby => ({
  id: randomUUID(), name: 'Amani Uwase', date_of_birth: '2026-03-14', sex: 'female',
  guardian_name: 'Grace', guardian_phone: '+250788000000', village: 'Kigali', updated_at: at(), ...o,
});
export const session = (babyId: string, o: Partial<ScreeningSession> = {}): ScreeningSession => ({
  id: randomUUID(), baby_id: babyId, started_at: at(), device_id: 'PS-BOARD-1', firmware_version: '2.0', updated_at: at(), ...o,
});
export const step = (sessionId: string, type: StepType, o: Partial<Step> = {}): Step => ({
  id: randomUUID(), session_id: sessionId, type, required: true, status: 'pending', updated_at: at(), ...o,
});
export const attempt = (stepId: string, o: Partial<Attempt> = {}): Attempt => ({
  id: randomUUID(), step_id: stepId, n: 1, values: {}, created_at: at(), ...o,
});

/** Open a websocket, authenticate, and collect messages. */
export async function wsClient(app: FastifyInstance, path: string, authMsg: Record<string, unknown>) {
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  const inbox: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  let closeCode: number | null = null;
  ws.on('message', (d) => { inbox.push(JSON.parse(d.toString())); waiters.splice(0).forEach((f) => f()); });
  ws.on('close', (code) => { closeCode = code; waiters.splice(0).forEach((f) => f()); });
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  ws.send(JSON.stringify(authMsg));
  const next = async (type?: string, timeoutMs = 2000): Promise<Record<string, unknown>> => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const i = inbox.findIndex((m) => !type || m.type === type);
      if (i >= 0) return inbox.splice(i, 1)[0];
      if (closeCode !== null) throw new Error(`socket closed (${closeCode})`);
      if (Date.now() > end) throw new Error(`timeout waiting for ${type ?? 'message'}`);
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); });
    }
  };
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  const closed = async (): Promise<number> => {
    const end = Date.now() + 2000;
    while (closeCode === null && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return closeCode ?? -1;
  };
  return { ws, next, send, closed, inbox };
}
