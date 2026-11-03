// Laptop server API (server/PROTOCOL.md). Same origin through the Vite proxy.
import type { Attempt, Baby, Role, ScreeningSession, Step } from '@pneumo/server/wire';

export interface Me { id: string; username: string; name: string; role: Role }
export type BabyRow = Baby & { last_visit: string | null; incomplete_sessions: number };

let token: string | null = localStorage.getItem('ps_token');
let onSignedOut: () => void = () => {};
export const setSignedOutHandler = (fn: () => void): void => { onSignedOut = fn; };
export const hasToken = (): boolean => !!token;

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.body && !(init.body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
  if (res.status === 401 && path !== '/api/login') { signOutLocal(); onSignedOut(); throw new Error('Signed out. Please sign in again.'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `${res.status} ${res.statusText}`);
  return body as T;
}

function signOutLocal(): void { token = null; localStorage.removeItem('ps_token'); }

export async function login(username: string, password: string): Promise<void> {
  const r = await call<{ token: string }>('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  token = r.token;
  localStorage.setItem('ps_token', token);
}
export async function logout(): Promise<void> {
  await call('/api/logout', { method: 'POST' }).catch(() => {});
  signOutLocal();
}
export const me = (): Promise<Me> => call('/api/me');
export const searchBabies = (q: string): Promise<BabyRow[]> => call('/api/babies/search', { method: 'POST', body: JSON.stringify({ q }) });

type ApplyResult = { status: string; error?: string };
async function put(table: 'babies' | 'sessions' | 'steps', rec: { id: string }): Promise<void> {
  const r = await call<ApplyResult>(`/api/${table}/${rec.id}`, { method: 'PUT', body: JSON.stringify(rec) });
  if (r.status === 'rejected') throw new Error(r.error || 'rejected');
}
export const saveBaby = (b: Baby): Promise<void> => put('babies', b);
export const saveSession = (s: ScreeningSession): Promise<void> => put('sessions', s);
export const saveStep = (s: Step): Promise<void> => put('steps', s);
export async function saveAttempt(a: Attempt): Promise<void> {
  const r = await call<ApplyResult>('/api/attempts', { method: 'POST', body: JSON.stringify(a) });
  if (r.status === 'rejected') throw new Error(r.error || 'rejected');
}

/** Upload 16-bit PCM in 64 KB chunks; the server stores it as WAV. */
export async function uploadRecording(id: string, pcm: Int16Array, sampleRate: number): Promise<void> {
  const bytes = new Uint8Array(pcm.byteLength);
  bytes.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const CHUNK = 64 * 1024;
  for (let o = 0; o < bytes.length; o += CHUNK) {
    await call(`/api/recordings/${id}?offset=${o}`, {
      method: 'PUT', body: bytes.slice(o, o + CHUNK),
      headers: { 'content-type': 'application/octet-stream', 'x-total-bytes': String(bytes.length), 'x-sample-rate': String(sampleRate), 'x-sha256': sha },
    });
  }
}

/** Is the clinic server reachable? (no sign-in needed) */
export async function online(): Promise<boolean> {
  try { return (await fetch('/api/health', { cache: 'no-store' })).ok; } catch { return false; }
}

/** A child's earlier screenings, newest first. */
export const babySessions = (id: string): Promise<ScreeningSession[]> => call(`/api/babies/${id}/sessions`);
