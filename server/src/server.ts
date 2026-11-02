import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { login, logout, type Worker, workerForToken } from './auth.ts';
import { babyAnalytics, overview } from './analytics.ts';
import { audit, currentRev, type DB, openDb } from './db.ts';
import { applyChange, babyScope, canAccessBaby, getRecord, pull, toRecord } from './records.ts';
import { canAccessRecording, getRecording, MAX_RECORDING_BYTES, putChunk, UploadError } from './recordings.ts';
import { createReadStream } from 'node:fs';
import {
  type ApplyResult, type Change, LIVE_KINDS, type LiveClientMsg, type LiveServerMsg, type SyncClientMsg,
  type SyncServerMsg, type TableName,
} from './wire.ts';

export interface ServerOptions { dbPath: string; dataDir: string; logger?: boolean; corsOrigins?: string[] }

const DEFAULT_ORIGINS = [
  'capacitor://localhost', 'ionic://localhost', 'http://localhost', 'https://localhost',
  'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173',
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BATCH = 500;

declare module 'fastify' {
  interface FastifyRequest { worker: Worker | null }
}

export async function buildServer(opts: ServerOptions): Promise<{ app: FastifyInstance; db: DB }> {
  const db = openDb(opts.dbPath);
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1_048_576 });
  await app.register(cors, { origin: opts.corsOrigins ?? DEFAULT_ORIGINS, exposedHeaders: ['x-received-bytes', 'x-state', 'x-total-bytes'] });
  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });
  await app.register(fastifyStatic, { root: fileURLToPath(new URL('../public/', import.meta.url)), prefix: '/' });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_RECORDING_BYTES }, (_req, body, done) => done(null, body));
  app.decorateRequest('worker', null);
  app.addHook('onClose', async () => db.close());

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/') || req.url === '/api/login' || req.url === '/api/health') return;
    const h = req.headers.authorization;
    req.worker = workerForToken(db, h?.startsWith('Bearer ') ? h.slice(7) : null);
    if (!req.worker) return reply.code(401).send({ error: 'unauthorized' });
  });

  const me = (req: FastifyRequest): Worker => req.worker!;
  const badId = (reply: FastifyReply) => reply.code(400).send({ error: 'id: expected a UUID' });
  const forbid = (reply: FastifyReply) => reply.code(404).send({ error: 'not found' });
  const send = (reply: FastifyReply, r: ApplyResult) =>
    reply.code(r.status !== 'rejected' ? 200 : r.error === 'forbidden' ? 403 : 400).send(r);
  const syncSockets = new Set<{ ws: WebSocket; worker: Worker }>();
  const poke = (except?: WebSocket) => {
    const msg: SyncServerMsg = { type: 'poke', rev: currentRev(db) };
    for (const s of syncSockets) if (s.ws !== except && s.ws.readyState === 1) s.ws.send(JSON.stringify(msg));
  };
  const applyOne = (w: Worker, change: Change) => {
    const r = applyChange(db, w, change);
    if (r.status === 'applied') poke();
    return r;
  };

  // ── auth ──
  app.get('/api/health', async () => ({ ok: true, rev: currentRev(db) }));
  app.post('/api/login', async (req, reply) => {
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown };
    if (typeof b.username !== 'string' || typeof b.password !== 'string') return reply.code(400).send({ error: 'username and password required' });
    const r = login(db, b.username, b.password);
    if (r === 'throttled') return reply.code(429).send({ error: 'too many attempts, wait 5 minutes' });
    if (!r) return reply.code(401).send({ error: 'wrong username or password' });
    audit(db, r.worker.id, 'login', 'worker', r.worker.id);
    return r;
  });
  app.post('/api/logout', async (req) => {
    logout(db, req.headers.authorization!.slice(7));
    return { ok: true };
  });
  app.get('/api/me', async (req) => me(req));
  app.get('/api/workers', async (req, reply) => {
    if (me(req).role !== 'supervisor') return reply.code(403).send({ error: 'supervisors only' });
    return db.prepare('SELECT id, username, name, role, active FROM workers ORDER BY name').all();
  });

  // ── babies ──
  app.post('/api/babies/search', async (req) => {
    const b = (req.body ?? {}) as { q?: unknown; limit?: unknown };
    const scope = babyScope(me(req));
    const q = typeof b.q === 'string' ? b.q.trim() : '';
    const limit = Math.min(Number(b.limit) || 100, 500);
    const rows = db
      .prepare(
        `SELECT b.*, (SELECT MAX(started_at) FROM sessions s WHERE s.baby_id = b.id AND s.deleted = 0) AS last_visit,
                (SELECT COUNT(*) FROM sessions s WHERE s.baby_id = b.id AND s.deleted = 0 AND s.status = 'incomplete') AS incomplete
         FROM babies b WHERE b.deleted = 0 AND ${scope.sql} AND (? = '' OR b.name LIKE ? OR b.village LIKE ? OR b.guardian_name LIKE ?)
         ORDER BY COALESCE(last_visit, b.updated_at) DESC LIMIT ?`,
      )
      .all(...scope.args, q, `%${q}%`, `%${q}%`, `%${q}%`, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ ...toRecord('babies', r), last_visit: r.last_visit, incomplete_sessions: r.incomplete }));
  });
  app.get<{ Params: { id: string } }>('/api/babies/:id', async (req, reply) => {
    if (!UUID.test(req.params.id)) return badId(reply);
    if (!canAccessBaby(db, me(req), req.params.id)) return forbid(reply);
    audit(db, me(req).id, 'read', 'baby', req.params.id);
    return getRecord(db, 'babies', req.params.id);
  });
  app.get<{ Params: { id: string } }>('/api/babies/:id/sessions', async (req, reply) => {
    if (!UUID.test(req.params.id)) return badId(reply);
    if (!canAccessBaby(db, me(req), req.params.id)) return forbid(reply);
    return (db.prepare('SELECT * FROM sessions WHERE baby_id = ? AND deleted = 0 ORDER BY started_at DESC').all(req.params.id) as Array<Record<string, unknown>>)
      .map((r) => toRecord('sessions', r));
  });

  const putRoute = (path: string, table: TableName) =>
    app.put<{ Params: { id: string } }>(path, async (req, reply) => {
      const record = (req.body ?? {}) as { id?: string };
      if (!UUID.test(req.params.id) || record.id?.toLowerCase() !== req.params.id.toLowerCase()) return badId(reply);
      return send(reply, applyOne(me(req), { table, record } as Change));
    });
  putRoute('/api/babies/:id', 'babies');
  putRoute('/api/sessions/:id', 'sessions');
  putRoute('/api/steps/:id', 'steps');
  app.post('/api/attempts', async (req, reply) => send(reply, applyOne(me(req), { table: 'attempts', record: req.body } as Change)));

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    if (!UUID.test(req.params.id)) return badId(reply);
    const s = getRecord(db, 'sessions', req.params.id) as { baby_id: string } | null;
    if (!s || !canAccessBaby(db, me(req), s.baby_id)) return forbid(reply);
    const steps = (db.prepare('SELECT * FROM steps WHERE session_id = ? AND deleted = 0').all(req.params.id) as Array<Record<string, unknown>>).map((r) => toRecord('steps', r));
    const attempts = (db.prepare('SELECT a.* FROM attempts a JOIN steps st ON st.id = a.step_id WHERE st.session_id = ? ORDER BY a.n').all(req.params.id) as Array<Record<string, unknown>>)
      .map((r) => toRecord('attempts', r));
    return { session: s, steps, attempts };
  });

  // ── recordings ──
  app.head<{ Params: { id: string } }>('/api/recordings/:id', async (req, reply) => {
    if (!UUID.test(req.params.id)) return badId(reply);
    const r = getRecording(db, req.params.id);
    if (!r || !canAccessRecording(db, me(req), r)) return reply.code(404).send();
    return reply.header('x-received-bytes', r.bytes_received).header('x-total-bytes', r.bytes_total).header('x-state', r.state).send();
  });
  app.put<{ Params: { id: string }; Querystring: { offset?: string } }>('/api/recordings/:id', async (req, reply) => {
    if (!UUID.test(req.params.id)) return badId(reply);
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'send the chunk as application/octet-stream' });
    const h = req.headers;
    try {
      const r = putChunk(db, opts.dataDir, me(req), req.params.id.toLowerCase(), Number(req.query.offset ?? 0), {
        total: Number(h['x-total-bytes']) || undefined,
        sampleRate: Number(h['x-sample-rate']) || undefined,
        sha256: typeof h['x-sha256'] === 'string' ? h['x-sha256'].toLowerCase() : undefined,
      }, req.body);
      return reply.header('x-received-bytes', r.bytes_received).header('x-state', r.state).send({ id: r.id, state: r.state, received: r.bytes_received, total: r.bytes_total });
    } catch (e) {
      if (!(e instanceof UploadError)) throw e;
      if (e.received !== undefined) reply.header('x-received-bytes', e.received);
      return reply.code(e.code).send({ error: e.message, received: e.received });
    }
  });
  app.get<{ Params: { id: string } }>('/api/recordings/:id', async (req, reply) => {
    if (!UUID.test(req.params.id)) return badId(reply);
    const r = getRecording(db, req.params.id);
    if (!r || !canAccessRecording(db, me(req), r)) return reply.code(404).send({ error: 'not found' });
    if (r.state !== 'complete' || !r.path) return reply.code(409).send({ error: 'upload incomplete', received: r.bytes_received });
    audit(db, me(req).id, 'read', 'recording', r.id);
    return reply.type('audio/wav').send(createReadStream(r.path));
  });

  // ── analytics ──
  app.get<{ Params: { id: string } }>('/api/analytics/baby/:id', async (req, reply) => {
    if (!UUID.test(req.params.id)) return badId(reply);
    if (!canAccessBaby(db, me(req), req.params.id)) return forbid(reply);
    audit(db, me(req).id, 'read', 'baby_analytics', req.params.id);
    return babyAnalytics(db, req.params.id);
  });
  app.get<{ Querystring: { from?: string; to?: string } }>('/api/analytics/overview', async (req) => overview(db, me(req), req.query));

  // ── websockets ──
  const authFirst = (ws: WebSocket, onAuth: (w: Worker, msg: Record<string, unknown>) => void, onMsg: (msg: Record<string, unknown>) => void) => {
    let worker: Worker | null = null;
    const timer = setTimeout(() => { if (!worker) ws.close(4401, 'auth timeout'); }, 5000);
    ws.on('close', () => clearTimeout(timer));
    ws.on('message', (data) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(data.toString()); } catch { ws.send(JSON.stringify({ type: 'error', error: 'invalid JSON' })); return; }
      if (!worker) {
        if (msg.type !== 'auth') { ws.close(4401, 'auth first'); return; }
        worker = workerForToken(db, typeof msg.token === 'string' ? msg.token : null);
        if (!worker) { ws.close(4401, 'unauthorized'); return; }
        clearTimeout(timer);
        onAuth(worker, msg);
        return;
      }
      onMsg(msg);
    });
  };

  app.register(async (scope) => {
    scope.get('/ws/sync', { websocket: true }, (ws: WebSocket) => {
      let entry: { ws: WebSocket; worker: Worker } | null = null;
      const out = (m: SyncServerMsg) => ws.readyState === 1 && ws.send(JSON.stringify(m));
      ws.on('close', () => { if (entry) syncSockets.delete(entry); });
      authFirst(ws, (w) => {
        entry = { ws, worker: w };
        syncSockets.add(entry);
        out({ type: 'auth_ok', worker: w });
      }, (raw) => {
        const msg = raw as SyncClientMsg;
        const w = entry!.worker;
        if (msg.type === 'push') {
          if (!Array.isArray(msg.changes) || msg.changes.length > MAX_BATCH) return out({ type: 'error', error: `push: 1–${MAX_BATCH} changes` });
          const results = msg.changes.map((c) => applyChange(db, w, c));
          out({ type: 'ack', batch_id: String(msg.batch_id ?? ''), results });
          if (results.some((r) => r.status === 'applied')) poke(ws);
        } else if (msg.type === 'pull') {
          const since = Number(msg.since);
          if (!Number.isInteger(since) || since < 0) return out({ type: 'error', error: 'pull: since must be a non-negative integer' });
          out({ type: 'changes', ...pull(db, w, since, msg.limit) });
        } else {
          out({ type: 'error', error: `unknown message type` });
        }
      });
    });

    const live = new Map<string, Set<{ ws: WebSocket; role: 'publisher' | 'watcher'; worker: Worker }>>();
    scope.get<{ Params: { id: string } }>('/ws/session/:id', { websocket: true }, (ws: WebSocket, req) => {
      const sessionId = req.params.id.toLowerCase();
      const out = (m: LiveServerMsg) => ws.readyState === 1 && ws.send(JSON.stringify(m));
      let member: { ws: WebSocket; role: 'publisher' | 'watcher'; worker: Worker } | null = null;
      const presence = () => {
        const set = live.get(sessionId);
        if (!set) return;
        const msg: LiveServerMsg = {
          type: 'presence',
          publishers: [...set].filter((m) => m.role === 'publisher').length,
          watchers: [...set].filter((m) => m.role === 'watcher').length,
        };
        for (const m of set) if (m.ws.readyState === 1) m.ws.send(JSON.stringify(msg));
      };
      ws.on('close', () => {
        if (!member) return;
        live.get(sessionId)?.delete(member);
        if (!live.get(sessionId)?.size) live.delete(sessionId);
        presence();
      });
      authFirst(ws, (w, msg) => {
        const s = UUID.test(sessionId) ? (getRecord(db, 'sessions', sessionId) as { baby_id: string } | null) : null;
        if (!s || !canAccessBaby(db, w, s.baby_id)) { ws.close(4404, 'session not found'); return; }
        member = { ws, role: msg.role === 'publisher' ? 'publisher' : 'watcher', worker: w };
        if (!live.has(sessionId)) live.set(sessionId, new Set());
        live.get(sessionId)!.add(member);
        out({ type: 'auth_ok', watchers: [...live.get(sessionId)!].filter((m) => m.role === 'watcher').length });
        presence();
      }, (raw) => {
        const msg = raw as LiveClientMsg;
        if (msg.type !== 'event' || member!.role !== 'publisher') return out({ type: 'error', error: 'only publishers send events' });
        if (!msg.event || !LIVE_KINDS.includes(msg.event.kind)) return out({ type: 'error', error: `event.kind: one of ${LIVE_KINDS.join(', ')}` });
        const fwd: LiveServerMsg = { type: 'event', session_id: sessionId, event: msg.event, at: new Date().toISOString(), from: member!.worker.name };
        for (const m of live.get(sessionId) ?? []) if (m.role === 'watcher' && m.ws.readyState === 1) m.ws.send(JSON.stringify(fwd));
      });
    });
  });

  return { app, db };
}
