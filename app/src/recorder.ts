// Record one screening step: device → attempt → server. Every attempt is kept;
// the newest is accepted (status done, or poor when its quality is low).
import { useCallback, useEffect, useState } from 'react';
import type { StepType } from '@pneumo/server/wire';
import type { Progress } from './ble';
import { useDevice } from './device';
import { toAttempt, type AttemptView, type Screening } from './screening';

/** The last capture, for the live sensor monitor. */
export interface Capture { type: StepType; pcm?: Int16Array; accel?: Int16Array; at: number }
let last: Capture | null = null;
const subs = new Set<(c: Capture | null) => void>();
export function useLastCapture(): Capture | null {
  const [c, setC] = useState(last);
  useEffect(() => { subs.add(setC); return () => { subs.delete(setC); }; }, []);
  return c;
}

export function useStep(s: Screening, type: StepType, onChange: () => void) {
  const { gw, status, connected } = useDevice();
  const st = s.step(type);
  const [prog, setProg] = useState<Progress | null>(null);
  const [err, setErr] = useState('');
  // One step at a time: the board records or sends only one.
  const deviceBusy = !!status && (status.state === 1 || status.state === 2);
  const hasSensor = connected && !!status && (status.flags & st.def.needs) !== 0;
  const available = hasSensor && (!deviceBusy || prog !== null);
  const accepted: AttemptView | undefined = st.attempts.find((a) => a.attempt.id === st.step.accepted_attempt);

  const record = useCallback(async () => {
    setErr(''); setProg({ phase: 'recording', percent: 0 });
    try {
      const data = await gw.record(st.def.id, st.def.seconds, setProg);
      setProg({ phase: 'checking', percent: 100 });
      const a = await toAttempt(st.def, st.step.id, st.attempts.length + 1, data);
      st.attempts.push(a);
      if (a.pcm || data.accel) { last = { type, pcm: a.pcm, accel: data.accel, at: Date.now() }; subs.forEach((f) => f(last)); }
      // If the server is away, still accept it here so the screening can go on.
      const saved = await Promise.allSettled([s.saveAttempt(a).then(() => s.setStep(st, a.good ? 'done' : 'poor', a.attempt.id))]);
      if (st.step.accepted_attempt !== a.attempt.id) { st.step = { ...st.step, status: a.good ? 'done' : 'poor', accepted_attempt: a.attempt.id }; }
      if (saved[0].status === 'rejected') setErr(`Recorded, but not saved to the clinic server: ${(saved[0].reason as Error).message}`);
    } catch (e) {
      setErr((e as Error).message);
    }
    setProg(null);
    onChange();
  }, [gw, s, st, type, onChange]);

  const skip = useCallback(async () => {
    setErr('');
    try { await s.setStep(st, 'missing', null); } catch (e) { setErr((e as Error).message); }
    onChange();
  }, [s, st, onChange]);

  return { st, def: st.def, prog, busy: prog !== null, err, available, connected, hasSensor, accepted, record, skip, stop: () => void gw.stop() };
}
