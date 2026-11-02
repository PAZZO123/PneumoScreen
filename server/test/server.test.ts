import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { at, attempt, auth, baby, type Ctx, session, setup, step, wsClient } from './helpers.ts';

let c: Ctx;
beforeEach(async () => { c = await setup(); });
afterEach(async () => { await c.close(); });

const put = (token: string, url: string, payload: unknown) => c.app.inject({ method: 'PUT', url, headers: auth(token), payload: payload as object });
const get = (token: string, url: string) => c.app.inject({ method: 'GET', url, headers: auth(token) });
const create = async <T extends { id: string }>(token: string, table: 'babies' | 'sessions' | 'steps', rec: T) => {
  const r = await put(token, `/api/${table}/${rec.id}`, rec);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};

describe('auth', () => {
  it('requires a token on the API but not for login/health', async () => {
    expect((await c.app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    expect((await c.app.inject({ method: 'GET', url: '/api/me', headers: auth('nope') })).statusCode).toBe(401);
    expect((await c.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    expect((await get(c.tokens.a, '/api/me')).json()).toMatchObject({ username: 'alice', role: 'worker' });
  });

  it('rejects wrong passwords and throttles repeated failures', async () => {
    const bad = () => c.app.inject({ method: 'POST', url: '/api/login', payload: { username: 'bob', password: 'wrong' } });
    expect((await bad()).statusCode).toBe(401);
    for (let i = 0; i < 9; i++) await bad();
    expect((await bad()).statusCode).toBe(429);
  });

  it('logout invalidates the token', async () => {
    await c.app.inject({ method: 'POST', url: '/api/logout', headers: auth(c.tokens.b) });
    expect((await get(c.tokens.b, '/api/me')).statusCode).toBe(401);
  });

  it('lists workers for supervisors only', async () => {
    expect((await get(c.tokens.sup, '/api/workers')).json()).toHaveLength(3);
    expect((await get(c.tokens.a, '/api/workers')).statusCode).toBe(403);
  });
});

describe('access scoping', () => {
  it("a worker cannot read or write another worker's baby; supervisors can", async () => {
    const b = baby();
    await create(c.tokens.a, 'babies', b);
    expect((await get(c.tokens.b, `/api/babies/${b.id}`)).statusCode).toBe(404);
    expect((await get(c.tokens.b, `/api/analytics/baby/${b.id}`)).statusCode).toBe(404);
    const search = await c.app.inject({ method: 'POST', url: '/api/babies/search', headers: auth(c.tokens.b), payload: { q: 'Amani' } });
    expect(search.json()).toEqual([]);
    expect((await put(c.tokens.b, `/api/babies/${b.id}`, { ...b, name: 'X', updated_at: at(1000) })).statusCode).toBe(403);
    expect((await put(c.tokens.b, '/api/sessions/' + randomUUID(), {})).statusCode).toBe(400);
    const s = session(b.id);
    expect((await put(c.tokens.b, `/api/sessions/${s.id}`, s)).json()).toMatchObject({ status: 'rejected', error: 'forbidden' });
    expect((await get(c.tokens.sup, `/api/babies/${b.id}`)).json()).toMatchObject({ name: 'Amani Uwase', created_by: c.ids.a });
  });

  it('assigning a baby gives that worker access', async () => {
    const b = baby({ assigned_to: c.ids.b });
    await create(c.tokens.a, 'babies', b);
    expect((await get(c.tokens.b, `/api/babies/${b.id}`)).statusCode).toBe(200);
  });

  it('validates records and keeps personal data out of URLs', async () => {
    const b = baby({ date_of_birth: '14/03/2026' });
    expect((await put(c.tokens.a, `/api/babies/${b.id}`, b)).json()).toMatchObject({ status: 'rejected', error: expect.stringContaining('date_of_birth') });
    const b2 = baby({ name: '' });
    expect((await put(c.tokens.a, `/api/babies/${b2.id}`, b2)).statusCode).toBe(400);
    expect((await get(c.tokens.a, '/api/babies/not-a-uuid')).statusCode).toBe(400);
  });
});

describe('sync over /ws/sync', () => {
  beforeEach(async () => { await c.app.listen({ port: 0, host: '127.0.0.1' }); });

  it('applies, ignores stale and duplicate changes, and pulls by cursor', async () => {
    const a = await wsClient(c.app, '/ws/sync', { type: 'auth', token: c.tokens.a });
    expect(await a.next('auth_ok')).toMatchObject({ worker: { username: 'alice' } });
    const b = baby();
    const s = session(b.id);
    const st = step(s.id, 'breath');
    const att = attempt(st.id, { values: { bpm: 44 } });
    a.send({ type: 'push', batch_id: 'b1', changes: [
      { table: 'babies', record: b }, { table: 'sessions', record: s }, { table: 'steps', record: st }, { table: 'attempts', record: att },
    ] });
    const ack = await a.next('ack');
    expect((ack.results as Array<{ status: string }>).map((r) => r.status)).toEqual(['applied', 'applied', 'applied', 'applied']);

    a.send({ type: 'push', batch_id: 'b2', changes: [
      { table: 'babies', record: b },                                                  // same updated_at → stale
      { table: 'babies', record: { ...b, name: 'Old', updated_at: at(-5000) } },       // older → stale
      { table: 'attempts', record: { ...att, values: { bpm: 99 } } },                  // append-only → duplicate
      { table: 'steps', record: step(randomUUID(), 'temp') },                          // unknown session → rejected
      { table: 'steps', record: step(s.id, 'breath') },                                // second breath step → rejected
    ] });
    const ack2 = (await a.next('ack')).results as Array<{ status: string; error?: string }>;
    expect(ack2.map((r) => r.status)).toEqual(['stale', 'stale', 'duplicate', 'rejected', 'rejected']);
    expect(ack2[3].error).toMatch(/missing_parent/);
    expect(ack2[4].error).toMatch(/duplicate_step/);

    a.send({ type: 'push', batch_id: 'b3', changes: [{ table: 'babies', record: { ...b, name: 'Amani U.', updated_at: at(5000) } }] });
    expect(((await a.next('ack')).results as Array<{ status: string }>)[0].status).toBe('applied');

    a.send({ type: 'pull', since: 0 });
    const ch = await a.next('changes');
    const recs = ch.changes as Array<{ table: string; record: Record<string, unknown> }>;
    expect(recs.map((r) => r.table).sort()).toEqual(['attempts', 'babies', 'sessions', 'steps']);
    expect(recs.find((r) => r.table === 'babies')!.record.name).toBe('Amani U.');
    expect(recs.find((r) => r.table === 'attempts')!.record.values).toEqual({ bpm: 44 });
    a.send({ type: 'pull', since: ch.cursor });
    expect((await a.next('changes')).changes).toEqual([]);
    a.ws.close();
  });

  it("does not pull other workers' records, and pokes other devices", async () => {
    const a = await wsClient(c.app, '/ws/sync', { type: 'auth', token: c.tokens.a });
    const b = await wsClient(c.app, '/ws/sync', { type: 'auth', token: c.tokens.b });
    const sup = await wsClient(c.app, '/ws/sync', { type: 'auth', token: c.tokens.sup });
    await Promise.all([a.next('auth_ok'), b.next('auth_ok'), sup.next('auth_ok')]);
    a.send({ type: 'push', batch_id: 'x', changes: [{ table: 'babies', record: baby() }] });
    await a.next('ack');
    expect(await sup.next('poke')).toMatchObject({ type: 'poke' });
    b.send({ type: 'pull', since: 0 });
    expect((await b.next('changes')).changes).toEqual([]);
    sup.send({ type: 'pull', since: 0 });
    expect((await sup.next('changes')).changes).toHaveLength(1);
    for (const x of [a, b, sup]) x.ws.close();
  });

  it('closes unauthenticated sockets', async () => {
    const x = await wsClient(c.app, '/ws/sync', { type: 'auth', token: 'bad' });
    expect(await x.closed()).toBe(4401);
  });
});

describe('attempts and session status', () => {
  it('keeps attempts append-only', async () => {
    const b = baby(); const s = session(b.id); const st = step(s.id, 'lung_RU');
    for (const [t, r] of [['babies', b], ['sessions', s], ['steps', st]] as const) await create(c.tokens.a, t, r);
    const att = attempt(st.id, { values: { class: 'crackles' } });
    expect((await c.app.inject({ method: 'POST', url: '/api/attempts', headers: auth(c.tokens.a), payload: att })).json().status).toBe('applied');
    expect((await c.app.inject({ method: 'POST', url: '/api/attempts', headers: auth(c.tokens.a), payload: { ...att, values: { class: 'normal' } } })).json().status).toBe('duplicate');
    const detail = (await get(c.tokens.a, `/api/sessions/${s.id}`)).json();
    expect(detail.attempts[0].values).toEqual({ class: 'crackles' });
  });

  it('marks a session complete only when every required step is done', async () => {
    const b = baby(); const s = session(b.id);
    await create(c.tokens.a, 'babies', b);
    await create(c.tokens.a, 'sessions', s);
    const breath = step(s.id, 'breath');
    const lung = step(s.id, 'lung_RU');
    const temp = step(s.id, 'temp', { required: false });
    for (const st of [breath, lung, temp]) await create(c.tokens.a, 'steps', st);
    const status = async () => (await get(c.tokens.a, `/api/sessions/${s.id}`)).json().session.status;
    expect(await status()).toBe('incomplete');
    await create(c.tokens.a, 'steps', { ...breath, status: 'done', updated_at: at(1000) });
    expect(await status()).toBe('incomplete');
    await create(c.tokens.a, 'steps', { ...lung, status: 'done', updated_at: at(1000) });
    expect(await status()).toBe('complete');
    await create(c.tokens.a, 'steps', { ...lung, status: 'poor', updated_at: at(2000) });   // re-record needed
    expect(await status()).toBe('incomplete');
  });

  it('rejects accepting an attempt from another step', async () => {
    const b = baby(); const s = session(b.id); const s1 = step(s.id, 'lung_RU'); const s2 = step(s.id, 'lung_LU');
    for (const [t, r] of [['babies', b], ['sessions', s], ['steps', s1], ['steps', s2]] as const) await create(c.tokens.a, t, r);
    const att = attempt(s1.id);
    await c.app.inject({ method: 'POST', url: '/api/attempts', headers: auth(c.tokens.a), payload: att });
    const r = await put(c.tokens.a, `/api/steps/${s2.id}`, { ...s2, accepted_attempt: att.id, updated_at: at(1000) });
    expect(r.json()).toMatchObject({ status: 'rejected', error: expect.stringContaining('another step') });
  });
});

describe('recording upload', () => {
  const pcm = Buffer.from(new Int16Array(40000).map((_, i) => Math.round(Math.sin(i / 9) * 8000)).buffer);
  const sha = createHash('sha256').update(pcm).digest('hex');
  const chunk = (token: string, id: string, offset: number, body: Buffer, digest = sha) =>
    c.app.inject({
      method: 'PUT', url: `/api/recordings/${id}?offset=${offset}`, payload: body,
      headers: { ...auth(token), 'content-type': 'application/octet-stream', 'x-total-bytes': String(pcm.length), 'x-sample-rate': '4000', 'x-sha256': digest },
    });

  it('resumes from the received offset and verifies sha256', async () => {
    const id = randomUUID();
    expect((await chunk(c.tokens.a, id, 0, pcm.subarray(0, 30000))).json()).toMatchObject({ state: 'partial', received: 30000 });
    const head = await c.app.inject({ method: 'HEAD', url: `/api/recordings/${id}`, headers: auth(c.tokens.a) });
    expect(head.headers['x-received-bytes']).toBe('30000');
    const wrong = await chunk(c.tokens.a, id, 10000, pcm.subarray(10000));
    expect(wrong.statusCode).toBe(409);
    expect(wrong.headers['x-received-bytes']).toBe('30000');
    expect((await chunk(c.tokens.b, id, 30000, pcm.subarray(30000))).statusCode).toBe(403);
    expect((await chunk(c.tokens.a, id, 30000, pcm.subarray(30000))).json()).toMatchObject({ state: 'complete', received: pcm.length });
    const wav = await get(c.tokens.a, `/api/recordings/${id}`);
    expect(wav.headers['content-type']).toBe('audio/wav');
    const body = wav.rawPayload;
    expect(body.subarray(0, 4).toString()).toBe('RIFF');
    expect(body.readUInt32LE(24)).toBe(4000);
    expect(body.subarray(44).equals(pcm)).toBe(true);
    expect((await get(c.tokens.b, `/api/recordings/${id}`)).statusCode).toBe(404);
    expect((await get(c.tokens.sup, `/api/recordings/${id}`)).statusCode).toBe(200);
  });

  it('restarts an upload whose checksum does not match', async () => {
    const id = randomUUID();
    const bad = createHash('sha256').update('something else').digest('hex');
    const r = await chunk(c.tokens.a, id, 0, pcm, bad);
    expect(r.statusCode).toBe(422);
    expect(r.headers['x-received-bytes']).toBe('0');
  });

  it('validates upload headers', async () => {
    const r = await c.app.inject({
      method: 'PUT', url: `/api/recordings/${randomUUID()}?offset=0`, payload: Buffer.alloc(10),
      headers: { ...auth(c.tokens.a), 'content-type': 'application/octet-stream' },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('analytics', () => {
  async function visit(token: string, babyId: string, day: number, opts: { bpm: number; lung: string; refer: boolean; finish: boolean }) {
    const s = session(babyId, { started_at: at(day * 86400000), result: { refer: opts.refer, reasons: opts.refer ? ['x'] : [], rules_version: '1.1' } });
    await create(token, 'sessions', s);
    const breath = step(s.id, 'breath');
    const lung = step(s.id, 'lung_RU');
    await create(token, 'steps', breath);
    await create(token, 'steps', lung);
    const a1 = attempt(breath.id, { values: { bpm: opts.bpm } });
    const old = attempt(lung.id, { n: 1, values: { class: 'noise' }, quality: 'noise' });
    const a2 = attempt(lung.id, { n: 2, values: { class: opts.lung } });
    for (const a of [a1, old, a2]) await c.app.inject({ method: 'POST', url: '/api/attempts', headers: auth(token), payload: a });
    await create(token, 'steps', { ...breath, status: 'done', accepted_attempt: a1.id, updated_at: at(1) });
    if (opts.finish) await create(token, 'steps', { ...lung, status: 'done', accepted_attempt: a2.id, updated_at: at(1) });
    return s;
  }

  it('builds per-baby trends from accepted attempts', async () => {
    const b = baby();
    await create(c.tokens.a, 'babies', b);
    await visit(c.tokens.a, b.id, 0, { bpm: 38, lung: 'normal', refer: false, finish: true });
    await visit(c.tokens.a, b.id, 7, { bpm: 52, lung: 'crackles', refer: true, finish: true });
    const r = (await get(c.tokens.a, `/api/analytics/baby/${b.id}`)).json();
    expect(r.visits).toHaveLength(2);
    expect(r.trends.breath_bpm.map((p: { value: number }) => p.value)).toEqual([38, 52]);
    expect(r.lung_grid.map((g: { RU: string }) => g.RU)).toEqual(['normal', 'crackles']);
    expect(r.visits[1]).toMatchObject({ refer: true, status: 'complete', missing: [] });
  });

  it('counts screenings and lists missing steps to follow up', async () => {
    const b1 = baby(); const b2 = baby({ name: 'Keza' }); const b3 = baby({ name: 'Bob baby' });
    await create(c.tokens.a, 'babies', b1);
    await create(c.tokens.a, 'babies', b2);
    await create(c.tokens.b, 'babies', b3);
    await visit(c.tokens.a, b1.id, 0, { bpm: 40, lung: 'normal', refer: false, finish: true });
    await visit(c.tokens.a, b2.id, 0, { bpm: 55, lung: 'wheezes', refer: true, finish: false });
    await visit(c.tokens.b, b3.id, 1, { bpm: 30, lung: 'normal', refer: false, finish: true });

    const sup = (await get(c.tokens.sup, '/api/analytics/overview')).json();
    expect(sup.totals).toMatchObject({ babies: 3, sessions: 3, complete: 2, incomplete: 1, referred: 1 });
    expect(sup.totals.refer_rate).toBeCloseTo(1 / 3);
    expect(sup.follow_up).toHaveLength(1);
    expect(sup.follow_up[0]).toMatchObject({ baby_name: 'Keza', missing: ['lung_RU'] });
    expect(sup.per_worker).toHaveLength(2);
    expect(sup.devices[0]).toMatchObject({ device_id: 'PS-BOARD-1', firmware_version: '2.0' });

    const alice = (await get(c.tokens.a, '/api/analytics/overview')).json();
    expect(alice.totals).toMatchObject({ babies: 2, sessions: 2 });
    expect(alice.devices).toEqual([]);
    const ranged = (await get(c.tokens.sup, `/api/analytics/overview?from=${at(86400000).slice(0, 10)}`)).json();
    expect(ranged.totals.sessions).toBe(1);
  });
});

describe('live session channel', () => {
  beforeEach(async () => { await c.app.listen({ port: 0, host: '127.0.0.1' }); });

  it('forwards publisher events to watchers', async () => {
    const b = baby(); const s = session(b.id);
    await create(c.tokens.a, 'babies', b);
    await create(c.tokens.a, 'sessions', s);
    const watcher = await wsClient(c.app, `/ws/session/${s.id}`, { type: 'auth', token: c.tokens.sup, role: 'watcher' });
    await watcher.next('auth_ok');
    expect(await watcher.next('presence')).toMatchObject({ publishers: 0, watchers: 1 });
    const phone = await wsClient(c.app, `/ws/session/${s.id}`, { type: 'auth', token: c.tokens.a, role: 'publisher' });
    await phone.next('auth_ok');
    expect(await watcher.next('presence')).toMatchObject({ publishers: 1, watchers: 1 });
    phone.send({ type: 'event', event: { kind: 'step_started', step: 'lung_RU', seconds: 10 } });
    expect(await watcher.next('event')).toMatchObject({ session_id: s.id, from: 'Alice', event: { kind: 'step_started', step: 'lung_RU' } });
    phone.send({ type: 'event', event: { kind: 'hack' } });
    expect(await phone.next('error')).toMatchObject({ type: 'error' });
    watcher.send({ type: 'event', event: { kind: 'result' } });
    expect(await watcher.next('error')).toMatchObject({ error: expect.stringContaining('publishers') });
    phone.ws.close(); watcher.ws.close();
  });

  it("refuses sessions the worker can't see", async () => {
    const b = baby(); const s = session(b.id);
    await create(c.tokens.a, 'babies', b);
    await create(c.tokens.a, 'sessions', s);
    const x = await wsClient(c.app, `/ws/session/${s.id}`, { type: 'auth', token: c.tokens.b, role: 'watcher' });
    expect(await x.closed()).toBe(4404);
  });
});
