import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertOctagon, AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, CircleDot, HeartPulse, Loader2, Mic, Square, Thermometer, Wind,
} from 'lucide-react';
import { AGE_BANDS, DANGER_SIGNS, FEVER_FROM_C, ageBand, type DangerSign, type TriageResult } from '@pneumo/dsp';
import type { Baby, ScreeningSession, StepType } from '@pneumo/server/wire';
import * as api from '../api';
import { useDevice, useLevel } from '../device';
import { useStep } from '../recorder';
import { STEPS, Screening, type AttemptView } from '../screening';
import { ChestChart, LevelMeter, ProbBars, Spectrogram, Spo2Gauge, Waveform } from '../components/Charts';
import { Badge, Bar, Button, Card, Note } from '../components/ui';
import { ageText } from './Patients';

const PAGES = ['Patient', 'Vitals', 'Lungs', 'Triage'] as const;
const LUNGS = [
  { type: 'lung_RU', pos: 'RU', label: 'Right upper', n: 1 }, { type: 'lung_LU', pos: 'LU', label: 'Left upper', n: 2 },
  { type: 'lung_RL', pos: 'RL', label: 'Right lower', n: 3 }, { type: 'lung_LL', pos: 'LL', label: 'Left lower', n: 4 },
] as const;

export function Wizard({ baby, onExit }: { baby: Baby; onExit: () => void }) {
  const { gw } = useDevice();
  const [s, setS] = useState<Screening | null>(null);
  const [page, setPage] = useState(0);
  const [, bump] = useState(0);
  const refresh = useCallback(() => bump((n) => n + 1), []);
  const [err, setErr] = useState('');
  const [dangerSigns, setDangerSigns] = useState<DangerSign[]>([]);

  const begin = async () => {
    setErr('');
    const sc = new Screening(baby, gw);
    sc.dangerSigns = dangerSigns;
    try { await sc.start(); setS(sc); setPage(1); window.scrollTo(0, 0); } catch (e) { setErr((e as Error).message); }
  };
  const go = (p: number) => { setPage(p); window.scrollTo(0, 0); };
  const done = (types: StepType[]) => !!s && types.every((t) => s.step(t).step.status !== 'pending');

  return (
    <div className="space-y-4">
      <ol className="grid grid-cols-4 gap-2" aria-label="Screening steps">
        {PAGES.map((p, i) => {
          const complete = i === 0 ? !!s : i === 1 ? done(['breath', 'temp', 'spo2']) : i === 2 ? done(LUNGS.map((l) => l.type)) : false;
          const here = i === page;
          return (
            <li key={p}>
              <button disabled={!s && i > 0} onClick={() => go(i)} aria-current={here ? 'step' : undefined}
                className={`flex w-full flex-col items-center gap-1 rounded-xl py-2 text-sm font-semibold disabled:opacity-50 sm:flex-row sm:justify-center sm:text-sm ${here ? 'bg-teal-700 text-white dark:bg-teal-500 dark:text-slate-950' : 'bg-white text-slate-700 dark:bg-slate-900 dark:text-slate-300'}`}>
                <span className={`grid h-6 w-6 place-items-center rounded-full text-sm ${here ? 'bg-white/25' : complete ? 'bg-emerald-600 text-white' : 'bg-slate-200 dark:bg-slate-700'}`}>
                  {complete && !here ? <Check className="h-3.5 w-3.5" /> : i + 1}
                </span>{p}
              </button>
            </li>
          );
        })}
      </ol>

      {page === 0 && <PatientStep baby={baby} started={!!s} signs={s ? s.dangerSigns : dangerSigns}
        onSigns={(v) => { if (s) { s.dangerSigns = v; refresh(); } else setDangerSigns(v); }} onBegin={s ? () => go(1) : begin} onBack={onExit} err={err} />}
      {s && page === 1 && <VitalsStep s={s} refresh={refresh} onNext={() => go(2)} />}
      {s && page === 2 && <LungsStep s={s} refresh={refresh} onNext={() => go(3)} />}
      {s && page === 3 && <TriageStep s={s} onRecord={(p) => go(p)} onExit={onExit} />}
    </div>
  );
}

// ── 1. patient ──
function PatientStep({ baby, started, signs, onSigns, onBegin, onBack, err }: {
  baby: Baby; started: boolean; signs: DangerSign[]; onSigns: (v: DangerSign[]) => void; onBegin: () => void; onBack: () => void; err: string;
}) {
  let band = 3;
  try { band = ageBand(new Date(baby.date_of_birth)); } catch { /* future DOB: treat as unknown */ }
  return (
    <>
      <Card title={baby.name} right={!started && <Button variant="ghost" onClick={onBack}><ArrowLeft className="h-4 w-4" />Change</Button>}>
        <p className="text-slate-600 dark:text-slate-600">{ageText(baby.date_of_birth)} old · <span className="capitalize">{baby.sex}</span> · {baby.village || 'no village'}
          {baby.guardian_name && <> · guardian {baby.guardian_name}{baby.guardian_phone ? ` (${baby.guardian_phone})` : ''}</>}</p>
        <h3 className="mb-2 mt-4 text-sm font-semibold text-slate-700 dark:text-slate-300">Age group (from date of birth) and WHO fast-breathing threshold</h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {AGE_BANDS.map((b) => (
            <div key={b.band} aria-current={b.band === band}
              className={`rounded-xl border-2 p-3 text-center ${b.band === band ? 'border-teal-600 bg-teal-50 dark:bg-teal-950' : 'border-slate-200 opacity-60 dark:border-slate-700'}`}>
              <div className="text-sm font-semibold text-slate-900">{b.band === 3 ? 'Over 5 years / adult' : b.label[0].toUpperCase() + b.label.slice(1)}</div>
              <div className="text-sm text-slate-600 dark:text-slate-600">fast if ≥ {b.fastBreathFrom}/min</div>
            </div>
          ))}
        </div>
      </Card>
      <History babyId={baby.id} />
      <Card title="General danger signs (IMCI)" icon={<AlertOctagon className="h-5 w-5 text-rose-600" />}>
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-600">Look and ask. Any sign = urgent referral.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {DANGER_SIGNS.map((d) => (
            <label key={d.id} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border-2 border-slate-200 px-3 has-checked:border-rose-500 has-checked:bg-rose-50 dark:border-slate-700 dark:has-checked:bg-rose-950">
              <input type="checkbox" className="h-5 w-5 accent-rose-600" checked={signs.includes(d.id)}
                onChange={(e) => onSigns(e.target.checked ? [...signs, d.id] : signs.filter((x) => x !== d.id))} />
              <span className="font-medium text-slate-800 dark:text-slate-200">{d.label}</span>
            </label>
          ))}
        </div>
      </Card>
      {err && <Note tone="bad">{err}</Note>}
      <Sticky><Button big className="w-full" onClick={onBegin}>{started ? 'Continue to vital signs' : 'Start screening'}<ArrowRight className="h-5 w-5" /></Button></Sticky>
    </>
  );
}

function History({ babyId }: { babyId: string }) {
  const [list, setList] = useState<ScreeningSession[] | null>(null);
  useEffect(() => { api.babySessions(babyId).then(setList, () => setList([])); }, [babyId]);
  if (!list?.length) return null;
  const level = (x: ScreeningSession) => (x.result?.level as string | undefined) ?? (x.result == null ? null : x.result.refer ? 'refer' : 'normal');
  return (
    <Card title="Previous screenings">
      <ul className="divide-y divide-slate-100">
        {list.slice(0, 5).map((x) => {
          const l = level(x);
          return (
            <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <span className="font-medium">{new Date(x.started_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
              <span className="flex flex-wrap gap-1.5">
                {l === 'danger' ? <Badge tone="bad">Danger</Badge> : l === 'refer' ? <Badge tone="warn">Referred</Badge> : l === 'normal' ? <Badge tone="ok">Normal</Badge> : null}
                {x.status !== 'complete' && <Badge>unfinished</Badge>}
                {x.result?.simulated ? <Badge tone="info">demo</Badge> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ── shared recording controls ──
function Recorder({ s, type, refresh, idle }: { s: Screening; type: StepType; refresh: () => void; idle?: ReactNode }) {
  const r = useStep(s, type, refresh);
  const remaining = r.prog?.phase === 'recording' ? Math.ceil(r.def.seconds * (1 - r.prog.percent / 100)) : null;
  return (
    <div className="space-y-3">
      {r.busy && r.prog && (r.prog.phase === 'recording'
        ? <Countdown seconds={remaining ?? 0} percent={r.prog.percent} />
        : (
          <div className="space-y-2" aria-live="polite">
            <div className="flex items-center gap-2 font-semibold text-slate-800">
              <Loader2 className="h-5 w-5 animate-spin" />
              {r.prog.phase === 'receiving' ? 'Receiving from device' : r.def.where ? 'Analysing the sound (AI)' : 'Checking data'}
            </div>
            <Bar value={r.prog.percent} tone="amber" />
          </div>
        ))}
      {!r.busy && idle}
      {r.err && <Note tone="bad">{r.err}</Note>}
      {!r.busy && (!r.connected ? <Note>Connect the device to record.</Note> : !r.hasSensor && <Note>{sensorName(type)} was not found on the device.</Note>)}
      <div className="flex flex-wrap gap-2">
        {r.busy
          ? r.prog?.phase === 'recording' && r.def.seconds > 2 && <Button variant="secondary" onClick={r.stop}><Square className="h-4 w-4" />Stop early</Button>
          : <>
            <Button onClick={r.record} disabled={!r.available} className="flex-1">
              <CircleDot className="h-4 w-4" />{r.accepted ? 'Record again' : `Record ${r.def.seconds > 1 ? `${r.def.seconds} s` : ''}`}
            </Button>
            {r.st.step.status === 'pending' && <Button variant="secondary" onClick={r.skip}>Skip</Button>}
          </>}
      </div>
      {r.st.attempts.length > 1 && <p className="text-sm text-slate-600">{r.st.attempts.length} attempts kept; showing the newest.</p>}
      {r.st.step.status === 'missing' && <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">Skipped</p>}
    </div>
  );
}
/** The step's main button: pinned to the bottom of a phone screen, in the flow on a laptop. */
function Sticky({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-[5] -mx-4 border-t border-slate-200 bg-slate-100/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:p-0">
      {children}
    </div>
  );
}

/** Big ring: readable from arm's length while the worker holds the device. */
function Countdown({ seconds, percent }: { seconds: number; percent: number }) {
  const R = 52, C = 2 * Math.PI * R;
  return (
    <div className="flex flex-col items-center gap-1 py-2" role="timer" aria-live="off" aria-label={`${seconds} seconds left`}>
      <svg viewBox="0 0 120 120" className="h-36 w-36 -rotate-90">
        <circle cx="60" cy="60" r={R} fill="none" strokeWidth="10" className="stroke-slate-200" />
        <circle cx="60" cy="60" r={R} fill="none" strokeWidth="10" strokeLinecap="round" className="stroke-teal-600 transition-[stroke-dashoffset] duration-200"
          strokeDasharray={C} strokeDashoffset={C * (1 - percent / 100)} />
        <text x="60" y="60" dy="0.35em" textAnchor="middle" className="rotate-90 fill-slate-900 text-[34px] font-bold tabular-nums" style={{ transformOrigin: '60px 60px' }}>{seconds}</text>
      </svg>
      <span className="font-semibold text-slate-800">Recording… keep still</span>
    </div>
  );
}

const sensorName = (t: StepType) => (t === 'breath' ? 'The motion sensor' : t === 'temp' ? 'The temperature sensor' : t === 'spo2' ? 'The pulse oximeter' : 'The microphone');

const latest = (s: Screening, t: StepType): AttemptView | undefined => s.accepted(t) ?? s.step(t).attempts.at(-1);

// ── 2. vitals ──
function VitalsStep({ s, refresh, onNext }: { s: Screening; refresh: () => void; onNext: () => void }) {
  const band = AGE_BANDS[ageBand(new Date(s.baby.date_of_birth))];
  const breath = latest(s, 'breath'), spo2 = latest(s, 'spo2'), room = latest(s, 'temp');
  const bpm = breath?.attempt.values.bpm as number | undefined;
  const sat = spo2?.attempt.values.spo2 as number | undefined;
  const hr = spo2?.attempt.values.hr as number | undefined;
  const [temp, setTemp] = useState(s.bodyTempC?.toString() ?? '');
  const t = Number(temp);
  const tempOk = temp !== '' && t >= 30 && t <= 45;
  useEffect(() => { s.bodyTempC = tempOk ? Math.round(t * 10) / 10 : null; }, [s, t, tempOk]);
  const accel = useAccel(s);

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Respiratory rate" icon={<Wind className="h-5 w-5 text-teal-600" />}
          right={bpm ? <Badge tone={bpm >= band.fastBreathFrom ? 'bad' : 'ok'}>{bpm >= band.fastBreathFrom ? 'Fast breathing' : 'Normal'}</Badge> : null}>
          <div className="mb-3 inline-flex rounded-xl bg-slate-100 p-1 text-sm dark:bg-slate-800" role="radiogroup" aria-label="Method">
            <span className="rounded-lg bg-white px-3 py-1.5 font-semibold shadow-sm dark:bg-slate-700">Accelerometer (on belly)</span>
            <span className="px-3 py-1.5 text-slate-600" title="Not available yet">Camera: not available</span>
          </div>
          <Recorder s={s} type="breath" refresh={refresh} idle={
            <>
              <div className="flex items-baseline gap-2">
                <span className="text-5xl font-bold tabular-nums text-slate-900 dark:text-slate-50">{bpm || '--'}</span>
                <span className="text-slate-600">breaths/min · fast if ≥ {band.fastBreathFrom}</span>
              </div>
              {breath && !breath.good && <Note>{breath.summary}</Note>}
              {accel ? <ChestChart accel={accel} /> : <p className="text-sm text-slate-600 dark:text-slate-600">Device flat on the belly, below the ribs. Child calm. Don’t hold it.</p>}
            </>
          } />
        </Card>

        <Card title="SpO₂ and heart rate" icon={<HeartPulse className="h-5 w-5 text-rose-600" />}
          right={sat != null ? <Badge tone={sat < 90 ? 'bad' : sat < 95 ? 'warn' : 'ok'}>{sat < 90 ? 'Low: danger' : sat < 95 ? 'Borderline' : 'Normal'}</Badge> : null}>
          <Recorder s={s} type="spo2" refresh={refresh} idle={
            <div className="flex items-center justify-around gap-4">
              <Spo2Gauge value={sat ?? null} />
              <div className="text-center">
                <div className="text-4xl font-bold tabular-nums text-slate-900 dark:text-slate-50">{hr ?? '--'}</div>
                <div className="text-sm text-slate-600">heart rate /min</div>
              </div>
            </div>
          } />
        </Card>
      </div>

      <Card title="Temperature" icon={<Thermometer className="h-5 w-5 text-amber-600" />}
        right={tempOk ? <Badge tone={t >= FEVER_FROM_C ? 'bad' : 'ok'}>{t >= FEVER_FROM_C ? 'Fever' : 'No fever'}</Badge> : null}>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
            Body temperature from a thermometer (°C)
            <input type="number" inputMode="decimal" step="0.1" min="30" max="45" placeholder="e.g. 37.2" value={temp} onChange={(e) => setTemp(e.target.value)}
              className={`field text-2xl font-semibold ${temp && !tempOk ? 'border-rose-500' : ''}`} />
            <span className="mt-1 block text-sm text-slate-600">Fever is {FEVER_FROM_C} °C or more.</span>
          </label>
          <div>
            <div className="mb-1 text-sm font-medium text-slate-700 dark:text-slate-300">Room temperature (device sensor)</div>
            <Recorder s={s} type="temp" refresh={refresh} idle={
              <p className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {room ? `${(room.attempt.values.celsius as number).toFixed(1)} °C` : '--'}
                <span className="ml-2 text-sm font-normal text-slate-600">room air, not the child</span>
              </p>
            } />
          </div>
        </div>
      </Card>
      <Sticky><Button big className="w-full" onClick={onNext}>Continue to lung sounds<ArrowRight className="h-5 w-5" /></Button></Sticky>
    </>
  );
}

const useAccel = (s: Screening): Int16Array | undefined => latest(s, 'breath')?.accel;

// ── 3. lungs ──
function LungsStep({ s, refresh, onNext }: { s: Screening; refresh: () => void; onNext: () => void }) {
  const firstTodo = LUNGS.find((l) => s.step(l.type).step.status === 'pending') ?? LUNGS[0];
  const [sel, setSel] = useState<(typeof LUNGS)[number]>(firstTodo);
  const level = useLevel();
  const a = latest(s, sel.type);
  const probs = a?.attempt.model_output?.probs as Record<string, number> | null | undefined;
  const cls = a?.attempt.values.class as string | null | undefined;
  const { status } = useDevice();
  const busy = !!status && (status.state === 1 || status.state === 2);   // recording or sending

  // After a good recording, move on to the next position still to do.
  const after = useCallback(() => {
    refresh();
    const st = s.step(sel.type);
    if (st.step.status === 'done') {
      const next = LUNGS.find((l) => s.step(l.type).step.status === 'pending');
      if (next) setTimeout(() => setSel(next), 1200);
    }
  }, [refresh, s, sel.type]);

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Card title="Chest positions" icon={<Mic className="h-5 w-5 text-teal-600" />}>
          <ChestMap s={s} sel={sel.pos} onSel={(p) => !busy && setSel(LUNGS.find((l) => l.pos === p)!)} />
          <ul className="mt-3 grid grid-cols-2 gap-2 text-sm lg:grid-cols-1">
            {LUNGS.map((l) => {
              const st = s.step(l.type).step.status, c = latest(s, l.type)?.attempt.values.class as string | undefined;
              return (
                <li key={l.pos}><button disabled={busy} onClick={() => setSel(l)} className={`flex w-full items-center justify-between rounded-xl border-2 px-3 py-2 text-left ${sel.pos === l.pos ? 'border-teal-600' : 'border-slate-200 dark:border-slate-700'}`}>
                  <span className="font-medium">{l.n}. {l.label}</span>
                  <StatusDot status={st} cls={c} />
                </button></li>
              );
            })}
          </ul>
        </Card>
        <Card title={`${sel.n}. ${sel.label} chest`} right={cls ? <ClassBadge cls={cls} /> : null}>
          <div className="space-y-4">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-300">
              <li>Mic on the child’s <b>{sel.label.toLowerCase()}</b> chest (child’s own {sel.pos[0] === 'R' ? 'right' : 'left'}).</li>
              <li>On bare skin. Room quiet.</li>
              <li>Record. Hold still 10 seconds.</li>
            </ol>
            <LevelMeter level={level} active={busy} />
            <Recorder key={sel.type} s={s} type={sel.type} refresh={after} idle={a && (
              <div className="space-y-3">
                <Note tone={a.good ? 'ok' : 'warn'}>{a.summary}</Note>
                {probs && <ProbBars probs={probs} />}
                {a.pcm && <>
                  <Waveform pcm={a.pcm} />
                  <Spectrogram pcm={a.pcm} />
                  <Player pcm={a.pcm} />
                </>}
              </div>
            )} />
          </div>
        </Card>
      </div>
      <Sticky><Button big className="w-full" onClick={onNext}>See the result<ArrowRight className="h-5 w-5" /></Button></Sticky>
    </>
  );
}

function ChestMap({ s, sel, onSel }: { s: Screening; sel: string; onSel: (p: string) => void }) {
  const spots: Record<string, [number, number]> = { RU: [70, 92], LU: [130, 92], RL: [72, 150], LL: [128, 150] };
  const fill = (pos: string) => {
    const t = `lung_${pos}` as StepType, st = s.step(t).step.status, c = latest(s, t)?.attempt.values.class;
    if (st === 'pending') return '#94a3b8';
    if (st === 'missing') return '#cbd5e1';
    return c === 'normal' ? '#059669' : c === 'crackles' ? '#e11d48' : c === 'wheezes' ? '#d97706' : '#64748b';
  };
  return (
    <svg viewBox="0 0 200 220" className="mx-auto block w-full max-w-[260px]" role="group" aria-label="Chest positions, child facing you">
      <circle cx="100" cy="26" r="20" className="fill-orange-100 dark:fill-orange-950" />
      <path d="M42 64 Q100 44 158 64 L166 196 Q100 214 34 196 Z" className="fill-orange-100 stroke-orange-200 dark:fill-orange-950 dark:stroke-orange-900" strokeWidth="2" />
      <path d="M100 66 V190" className="stroke-orange-200 dark:stroke-orange-900" strokeWidth="2" strokeDasharray="4 4" />
      {[78, 100, 122, 144, 166].map((y) => <path key={y} d={`M54 ${y} Q78 ${y + 8} 94 ${y}`} className="fill-none stroke-orange-200 dark:stroke-orange-900" strokeWidth="1.5" />)}
      {[78, 100, 122, 144, 166].map((y) => <path key={`r${y}`} d={`M106 ${y} Q122 ${y + 8} 146 ${y}`} className="fill-none stroke-orange-200 dark:stroke-orange-900" strokeWidth="1.5" />)}
      <text x="56" y="214" fontSize="10" className="fill-slate-500">child’s R</text>
      <text x="120" y="214" fontSize="10" className="fill-slate-500">child’s L</text>
      {Object.entries(spots).map(([p, [x, y]], i) => (
        <g key={p} role="button" tabIndex={0} aria-label={`${p} position`} aria-pressed={sel === p} className="cursor-pointer focus:outline-none"
          onClick={() => onSel(p)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSel(p)}>
          {sel === p && <circle cx={x} cy={y} r="22" fill="none" stroke="#0d9488" strokeWidth="3" className="animate-pulse" />}
          <circle cx={x} cy={y} r="16" fill={fill(p)} />
          <text x={x} y={y + 5} textAnchor="middle" fontSize="14" fontWeight="700" fill="#fff">{i + 1}</text>
        </g>
      ))}
    </svg>
  );
}

function StatusDot({ status, cls }: { status: string; cls?: string }) {
  if (status === 'pending') return <span className="text-sm text-slate-600">to do</span>;
  if (status === 'missing') return <span className="text-sm text-amber-700 dark:text-amber-400">skipped</span>;
  return cls ? <ClassBadge cls={cls} small /> : <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
}
function ClassBadge({ cls, small }: { cls: string; small?: boolean }) {
  const tone = cls === 'normal' ? 'ok' : cls === 'crackles' ? 'bad' : cls === 'wheezes' ? 'warn' : 'muted';
  return <Badge tone={tone}>{small ? cls : cls.toUpperCase()}</Badge>;
}

function Player({ pcm }: { pcm: Int16Array }) {
  const url = useMemo(() => {
    const b = new DataView(new ArrayBuffer(44 + pcm.byteLength));
    const str = (o: number, t: string) => [...t].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); b.setUint32(4, 36 + pcm.byteLength, true); str(8, 'WAVE'); str(12, 'fmt ');
    b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true); b.setUint32(24, 4000, true);
    b.setUint32(28, 8000, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); str(36, 'data'); b.setUint32(40, pcm.byteLength, true);
    new Int16Array(b.buffer, 44).set(pcm);
    return URL.createObjectURL(new Blob([b.buffer], { type: 'audio/wav' }));
  }, [pcm]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <audio controls src={url} className="w-full" />;
}

// ── 4. triage ──
function TriageStep({ s, onRecord, onExit }: { s: Screening; onRecord: (page: number) => void; onExit: () => void }) {
  const r: TriageResult = s.result();
  const [saved, setSaved] = useState<'no' | 'saving' | 'yes' | string>('no');
  const save = async () => { setSaved('saving'); try { await s.finish(); setSaved('yes'); } catch (e) { setSaved((e as Error).message); } };
  const look = {
    danger: { box: 'bg-rose-600 text-white', icon: <AlertOctagon className="h-10 w-10" />, title: 'DANGER: refer urgently', line: 'Send the child to the health facility now.' },
    refer: { box: 'bg-amber-400 text-amber-950', icon: <AlertTriangle className="h-10 w-10" />, title: 'REFER', line: 'Send the child to the health facility today.' },
    normal: { box: 'bg-emerald-600 text-white', icon: <CheckCircle2 className="h-10 w-10" />, title: 'NORMAL', line: 'No danger or pneumonia signs found.' },
  }[r.level];
  const breath = latest(s, 'breath')?.attempt.values.bpm as number | undefined;
  const sat = latest(s, 'spo2')?.attempt.values.spo2 as number | undefined;
  return (
    <>
      <section className={`rounded-2xl p-5 shadow-sm ${look.box}`} aria-live="polite">
        <div className="flex items-center gap-4">{look.icon}<div><div className="text-2xl font-extrabold tracking-wide">{look.title}</div><p className="font-medium">{look.line}</p></div></div>
        {(r.urgent.length > 0 || r.reasons.length > 0) && (
          <ul className="mt-3 list-disc space-y-0.5 pl-6 font-medium">{[...r.urgent, ...r.reasons].map((x) => <li key={x}>{x}</li>)}</ul>
        )}
      </section>
      {s.simulated && <Note tone="info">Demo data: not for a real child.</Note>}
      {!r.complete && <Note>Incomplete: {r.missing.length} step{r.missing.length > 1 ? 's are' : ' is'} missing ({r.missing.map((m) => STEPS.find((d) => d.type === m)?.title ?? m).join(', ')}). The result can change once they are recorded.</Note>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Lung sounds (AI)">
          <ul className="space-y-3">
            {LUNGS.map((l) => {
              const a = latest(s, l.type), c = a?.attempt.values.class as string | undefined, p = a?.attempt.model_output?.probs as Record<string, number> | undefined;
              return (
                <li key={l.pos} className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60">
                  <div className="mb-2 flex items-center justify-between"><span className="font-semibold">{l.n}. {l.label}</span>{c ? <ClassBadge cls={c} /> : <Badge>not recorded</Badge>}</div>
                  {p && <ProbBars probs={p} />}
                </li>
              );
            })}
          </ul>
        </Card>
        <Card title="Vital signs">
          <dl className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {[
              ['Breathing', breath ? `${breath}/min${r.fastBreathing ? ' (fast)' : ''}` : 'not recorded', r.fastBreathing ? 'bad' : ''],
              ['SpO₂', sat != null ? `${sat}%` : 'not recorded', sat != null && sat < 90 ? 'bad' : sat != null && sat < 95 ? 'warn' : ''],
              ['Body temperature', s.bodyTempC != null ? `${s.bodyTempC.toFixed(1)} °C` : 'not entered', s.bodyTempC != null && s.bodyTempC >= FEVER_FROM_C ? 'bad' : ''],
              ['Danger signs', s.dangerSigns.length ? s.dangerSigns.map((d) => DANGER_SIGNS.find((x) => x.id === d)?.label).join(', ') : 'none', s.dangerSigns.length ? 'bad' : ''],
            ].map(([k, v, tone]) => (
              <div key={k} className="flex justify-between gap-4 py-2.5"><dt className="text-slate-600">{k}</dt>
                <dd className={`text-right font-semibold ${tone === 'bad' ? 'text-rose-600' : tone === 'warn' ? 'text-amber-600' : ''}`}>{v}</dd></div>
            ))}
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => onRecord(1)}>Edit vitals</Button>
            <Button variant="secondary" onClick={() => onRecord(2)}>Re-record lungs</Button>
          </div>
        </Card>
      </div>
      {saved === 'yes' ? (
        <>
          <Note tone="ok">Saved to the clinic server ({r.rulesVersion}).</Note>
          <Sticky><Button big className="w-full" onClick={onExit}>Next child<ArrowRight className="h-5 w-5" /></Button></Sticky>
        </>
      ) : (
        <>
          {saved !== 'no' && saved !== 'saving' && <Note tone="bad">Not saved: {saved}</Note>}
          <Sticky><Button big className="w-full" onClick={save} disabled={saved === 'saving'}>{saved === 'saving' ? 'Saving…' : 'Finish and save'}</Button></Sticky>
        </>
      )}
    </>
  );
}
