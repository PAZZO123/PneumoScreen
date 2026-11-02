// Wire types shared with the app (import type from '@pneumo/server/wire').
// Spec: server/PROTOCOL.md

export const ROLES = ['worker', 'supervisor'] as const;
export type Role = (typeof ROLES)[number];

export const STEP_TYPES = ['breath', 'lung_RU', 'lung_LU', 'lung_RL', 'lung_LL', 'temp', 'spo2'] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const STEP_STATUS = ['pending', 'done', 'missing', 'poor'] as const;
export type StepStatus = (typeof STEP_STATUS)[number];

export const SESSION_STATUS = ['incomplete', 'complete'] as const;
export type SessionStatus = (typeof SESSION_STATUS)[number];

export const SEXES = ['female', 'male', 'other', 'unknown'] as const;

/** Every syncable row: client-generated UUID, ISO-8601 updated_at, soft delete. */
export interface SyncFields { id: string; updated_at: string; deleted?: boolean; rev?: number }

export interface Baby extends SyncFields {
  name: string;
  date_of_birth: string; // YYYY-MM-DD
  sex: (typeof SEXES)[number];
  guardian_name?: string | null;
  guardian_phone?: string | null;
  village?: string | null;
  notes?: string | null;
  assigned_to?: string | null; // worker id
  created_by?: string;         // set by the server
}

export interface ScreeningSession extends SyncFields {
  baby_id: string;
  worker_id?: string;          // set by the server
  device_id?: string | null;
  firmware_version?: string | null;
  started_at: string;
  finished_at?: string | null;
  status?: SessionStatus;      // derived by the server from the steps
  result?: { refer: boolean; reasons: string[]; rules_version: string; [k: string]: unknown } | null;
}

export interface Step extends SyncFields {
  session_id: string;
  type: StepType;
  required: boolean;
  status: StepStatus;
  accepted_attempt?: string | null;
}

/** Append-only: an attempt is never changed once stored. */
export interface Attempt {
  id: string;
  step_id: string;
  n: number;
  values: Record<string, unknown>;
  quality?: string | null;
  model_output?: Record<string, unknown> | null;
  recording_id?: string | null;
  created_at: string;
  rev?: number;
}

export type TableName = 'babies' | 'sessions' | 'steps' | 'attempts';
export interface TableRecord { babies: Baby; sessions: ScreeningSession; steps: Step; attempts: Attempt }
export type Change = { [T in TableName]: { table: T; record: TableRecord[T] } }[TableName];

export type ApplyStatus = 'applied' | 'stale' | 'duplicate' | 'rejected';
export interface ApplyResult { table: TableName; id: string; status: ApplyStatus; rev?: number; error?: string }

// ── /ws/sync ──
export type SyncClientMsg =
  | { type: 'auth'; token: string }
  | { type: 'push'; batch_id: string; changes: Change[] }
  | { type: 'pull'; since: number; limit?: number };

export type SyncServerMsg =
  | { type: 'auth_ok'; worker: { id: string; username: string; name: string; role: Role } }
  | { type: 'ack'; batch_id: string; results: ApplyResult[] }
  | { type: 'changes'; changes: Change[]; cursor: number; more: boolean }
  | { type: 'poke'; rev: number }
  | { type: 'error'; error: string };

// ── /ws/session/:id ──
export const LIVE_KINDS = ['step_started', 'progress', 'level', 'step_done', 'step_failed', 'result', 'device'] as const;
export type LiveKind = (typeof LIVE_KINDS)[number];
export interface LiveEvent { kind: LiveKind; step?: StepType; [k: string]: unknown }

export type LiveClientMsg =
  | { type: 'auth'; token: string; role: 'publisher' | 'watcher' }
  | { type: 'event'; event: LiveEvent };

export type LiveServerMsg =
  | { type: 'auth_ok'; watchers: number }
  | { type: 'event'; session_id: string; event: LiveEvent; at: string; from: string }
  | { type: 'presence'; publishers: number; watchers: number }
  | { type: 'error'; error: string };
