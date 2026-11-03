import type { Worker } from './auth.ts';
import type { DB } from './db.ts';
import { babyScope } from './records.ts';

type Row = Record<string, unknown>;
const parse = (s: unknown): Record<string, unknown> | null => (typeof s === 'string' && s ? JSON.parse(s) : null);
const LUNG = ['lung_RU', 'lung_LU', 'lung_RL', 'lung_LL'] as const;
/** The app marks screenings made with its simulated device; they stay out of the statistics unless asked for. */
const DEMO = "COALESCE(s.firmware_version, '') = 'simulated'";
type Level = 'danger' | 'refer' | 'normal';
const levelOf = (result: Record<string, unknown> | null): Level | null =>
  result == null ? null : (result.level as Level | undefined) ?? (result.refer ? 'refer' : 'normal');

interface StepSummary { type: string; status: string; required: boolean; attempts: number; values: Record<string, unknown> | null; quality: string | null }

function stepsFor(db: DB, sessionId: string): StepSummary[] {
  const steps = db.prepare('SELECT * FROM steps WHERE session_id = ? AND deleted = 0 ORDER BY type').all(sessionId) as Row[];
  return steps.map((st) => {
    const attempts = db.prepare('SELECT * FROM attempts WHERE step_id = ? ORDER BY n, created_at').all(st.id as string) as Row[];
    const chosen = attempts.find((a) => a.id === st.accepted_attempt) ?? attempts.at(-1) ?? null;
    return {
      type: st.type as string,
      status: st.status as string,
      required: !!st.required,
      attempts: attempts.length,
      values: chosen ? parse(chosen.values) : null,
      quality: (chosen?.quality as string | null) ?? null,
    };
  });
}

function summarise(steps: StepSummary[]) {
  const by = new Map(steps.map((s) => [s.type, s]));
  const num = (type: string, key: string): number | null => {
    const v = by.get(type)?.values?.[key];
    return typeof v === 'number' ? v : null;
  };
  return {
    breath_bpm: num('breath', 'bpm'),
    room_temp_c: num('temp', 'celsius'),   // the device's AHT sensor: the room, not the child
    spo2: num('spo2', 'spo2'),
    lung: Object.fromEntries(LUNG.map((t) => [t.slice(5), (by.get(t)?.values?.class as string | undefined) ?? null])),
    missing: steps.filter((s) => s.required && s.status !== 'done').map((s) => s.type),
  };
}

export function babyAnalytics(db: DB, babyId: string) {
  const sessions = db
    .prepare(
      `SELECT s.*, w.name AS worker_name FROM sessions s JOIN workers w ON w.id = s.worker_id
       WHERE s.baby_id = ? AND s.deleted = 0 ORDER BY s.started_at`,
    )
    .all(babyId) as Row[];
  const visits = sessions.map((s) => {
    const steps = stepsFor(db, s.id as string);
    const result = parse(s.result);
    return {
      session_id: s.id, started_at: s.started_at, finished_at: s.finished_at, status: s.status,
      worker: s.worker_name, device_id: s.device_id,
      refer: (result?.refer as boolean | undefined) ?? null,
      level: levelOf(result),
      reasons: (result?.reasons as string[] | undefined) ?? [],
      body_temp_c: typeof result?.body_temp_c === 'number' ? result.body_temp_c : null,   // thermometer, typed by the worker
      danger_signs: (result?.danger_signs as string[] | undefined) ?? [],
      simulated: s.firmware_version === 'simulated',
      ...summarise(steps),
      steps,
    };
  });
  const trend = (k: 'breath_bpm' | 'body_temp_c' | 'spo2') =>
    visits.filter((v) => v[k] != null && !v.simulated).map((v) => ({ at: v.started_at, value: v[k] }));
  return {
    visits,
    trends: { breath_bpm: trend('breath_bpm'), body_temp_c: trend('body_temp_c'), spo2: trend('spo2') },
    lung_grid: visits.map((v) => ({ at: v.started_at, ...v.lung })),
  };
}

export function overview(db: DB, w: Worker, range: { from?: string; to?: string; demo?: boolean } = {}) {
  const scope = babyScope(w);
  const from = range.from ?? '0000';
  const to = range.to ?? '9999';
  const base = `FROM sessions s JOIN babies b ON b.id = s.baby_id JOIN workers wk ON wk.id = s.worker_id
                WHERE s.deleted = 0 AND b.deleted = 0 AND ${scope.sql} AND s.started_at >= ? AND s.started_at < ?${range.demo ? '' : ` AND NOT ${DEMO}`}`;
  const args = [...scope.args, from, to];
  const refer = "json_extract(s.result, '$.refer') = 1";
  const danger = "json_extract(s.result, '$.level') = 'danger'";

  const totals = db.prepare(
    `SELECT COUNT(*) AS sessions, SUM(s.status = 'complete') AS complete, SUM(s.status = 'incomplete') AS incomplete,
            SUM(${refer}) AS referred, SUM(${danger}) AS danger, SUM(s.result IS NOT NULL) AS with_result, COUNT(DISTINCT s.baby_id) AS babies_screened ${base}`,
  ).get(...args) as Row;
  const babies = db.prepare(`SELECT COUNT(*) AS n FROM babies b WHERE b.deleted = 0 AND ${scope.sql}`).get(...scope.args) as { n: number };
  const perDay = db.prepare(
    `SELECT substr(s.started_at, 1, 10) AS day, COUNT(*) AS sessions, SUM(${refer}) AS referred, SUM(${danger}) AS danger ${base} GROUP BY day ORDER BY day`,
  ).all(...args);
  const perWorker = db.prepare(
    `SELECT wk.id AS worker_id, wk.name AS worker, COUNT(*) AS sessions, SUM(s.status = 'complete') AS complete, SUM(${refer}) AS referred
     ${base} GROUP BY wk.id ORDER BY sessions DESC`,
  ).all(...args);
  const incomplete = db.prepare(
    `SELECT s.id AS session_id, s.baby_id, b.name AS baby_name, s.started_at, wk.name AS worker, ${DEMO} AS simulated ${base} AND s.status = 'incomplete'
     ORDER BY s.started_at DESC LIMIT 200`,
  ).all(...args) as Row[];
  const followUp = incomplete.map((r) => ({
    ...r,
    simulated: !!r.simulated,
    missing: (db.prepare("SELECT type FROM steps WHERE session_id = ? AND required = 1 AND deleted = 0 AND status != 'done' ORDER BY type")
      .all(r.session_id as string) as Array<{ type: string }>).map((x) => x.type),
  }));
  const devices = db.prepare('SELECT d.device_id, d.firmware_version, d.last_seen, w.name AS last_worker FROM devices d LEFT JOIN workers w ON w.id = d.last_worker ORDER BY d.last_seen DESC').all();
  const withResult = Number(totals.with_result ?? 0);
  return {
    totals: {
      babies: babies.n,
      babies_screened: Number(totals.babies_screened ?? 0),
      sessions: Number(totals.sessions ?? 0),
      complete: Number(totals.complete ?? 0),
      incomplete: Number(totals.incomplete ?? 0),
      referred: Number(totals.referred ?? 0),
      danger: Number(totals.danger ?? 0),
      refer_rate: withResult ? Number(totals.referred ?? 0) / withResult : null,
    },
    per_day: perDay,
    per_worker: w.role === 'supervisor' ? perWorker : perWorker.filter((r) => (r as Row).worker_id === w.id),
    follow_up: followUp,
    devices: w.role === 'supervisor' ? devices : [],
    demo_sessions: range.demo ? null : (db.prepare(`SELECT COUNT(*) AS n FROM sessions s JOIN babies b ON b.id = s.baby_id
      WHERE s.deleted = 0 AND b.deleted = 0 AND ${scope.sql} AND ${DEMO}`).get(...scope.args) as { n: number }).n,
  };
}
