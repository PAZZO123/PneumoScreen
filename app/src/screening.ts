// One screening: the steps a health worker records, what each attempt holds,
// and how it reaches the server. Every attempt is kept; the worker accepts one.
import { LungClassifier, MODEL, ageBand, triage, type DangerSign, type LungClass, type LungPosition, type TriageResult } from '@pneumo/dsp';
import { AUDIO_RATE, Step as StepIds, type StepData, type StepId } from '@pneumo/protocol';
import type { Attempt, Baby, ScreeningSession, Step, StepType } from '@pneumo/server/wire';
import modelUrl from '../../models/pneumo_lung_int8.tflite?url';
import * as api from './api';
import { Flag, type Gateway } from './ble';

export interface StepDef {
  type: StepType;
  id: StepId;
  title: string;
  seconds: number;
  needs: number;          // device flag
  required: boolean;
  how: string[];          // instructions shown before recording
  where?: string;         // lung position, for the body picture
}

const LUNG_HOW = (side: string, level: string) => [
  `Place the device’s microphone on the ${level} ${side} chest (the baby’s ${side}).`,
  'Hold it flat and still against the skin, not over clothes.',
  'Keep the room quiet; the baby can be held by the guardian.',
];

export const STEPS: StepDef[] = [
  { type: 'breath', id: StepIds.BREATH, title: 'Breathing rate', seconds: 30, needs: Flag.IMU_OK, required: true,
    how: ['Lay the device flat on the baby’s belly, just below the ribs.', 'Keep the baby calm and still; do not hold the device.', 'Recording takes 30 seconds.'] },
  { type: 'lung_RU', id: StepIds.LUNG_RU, title: 'Lungs: right upper', seconds: 10, needs: Flag.MIC_OK, required: true, where: 'RU', how: LUNG_HOW('right', 'upper') },
  { type: 'lung_LU', id: StepIds.LUNG_LU, title: 'Lungs: left upper', seconds: 10, needs: Flag.MIC_OK, required: true, where: 'LU', how: LUNG_HOW('left', 'upper') },
  { type: 'lung_RL', id: StepIds.LUNG_RL, title: 'Lungs: right lower', seconds: 10, needs: Flag.MIC_OK, required: true, where: 'RL', how: LUNG_HOW('right', 'lower') },
  { type: 'lung_LL', id: StepIds.LUNG_LL, title: 'Lungs: left lower', seconds: 10, needs: Flag.MIC_OK, required: true, where: 'LL', how: LUNG_HOW('left', 'lower') },
  { type: 'temp', id: StepIds.TEMP, title: 'Room temperature', seconds: 1, needs: Flag.TEMP_OK, required: false,
    how: ['Hold the device in the room air for a moment.', 'This is the room temperature, not the baby’s.'] },
  // SpO₂ stays optional until the gateway firmware supports the MAX30102 step.
  { type: 'spo2', id: StepIds.SPO2, title: 'Oxygen (SpO₂)', seconds: 15, needs: Flag.SPO2_OK, required: false,
    how: ['Put the pulse sensor on the baby’s big toe or finger.', 'Keep the foot still for 15 seconds.'] },
];

export interface AttemptView {
  attempt: Attempt;
  summary: string;
  good: boolean;
  pcm?: Int16Array;
  accel?: Int16Array;   // breath: the 10 Hz movement, for the chart (not uploaded yet)
  saved: boolean;
  saveError?: string;
}

export interface StepState {
  def: StepDef;
  step: Step;
  attempts: AttemptView[];
}

let classifier: Promise<LungClassifier> | null = null;
export function loadModel(): Promise<LungClassifier> {
  classifier ??= fetch(modelUrl).then((r) => {
    if (!r.ok) throw new Error('lung model not found');
    return r.arrayBuffer();
  }).then((b) => LungClassifier.fromBytes(b));
  return classifier;
}

const LUNG_WORDS: Record<LungClass, string> = { normal: 'normal sounds', crackles: 'crackles', wheezes: 'wheezes', noise: 'too noisy to judge' };

/** Turn what the board sent into an attempt (values, quality, model output). */
export async function toAttempt(def: StepDef, stepId: string, n: number, data: StepData): Promise<AttemptView> {
  const base: Attempt = { id: crypto.randomUUID(), step_id: stepId, n, values: {}, created_at: new Date().toISOString() };
  if (def.type === 'breath') {
    const bpm = data.breath?.bpm ?? 0, quality = data.breath?.quality ?? 0;
    const good = bpm > 0 && quality >= 40;
    return {
      attempt: { ...base, values: { bpm, signal_quality: quality }, quality: good ? 'good' : 'poor' }, saved: false, good, accel: data.accel,
      summary: bpm > 0 ? `${bpm} breaths per minute (signal ${quality}%)` : 'No breathing seen. Put the device on the belly and keep the child calm.',
    };
  }
  if (def.where) {
    const pcm = data.audio ?? new Int16Array();
    const clip = (await loadModel()).classifyClip(pcm);
    const probs = clip.probs ? Object.fromEntries(MODEL.CLASS_NAMES.map((c: string, i: number) => [c, Math.round(clip.probs![i] * 1000) / 1000])) : null;
    const good = clip.quality === 'ok' && clip.best !== 'noise' && clip.best != null;
    const why = { ok: '', silent: 'Too quiet. Press the mic on the skin.', short: 'Recording too short.', noise: 'Too noisy. Keep still and quiet.' }[clip.quality];
    return {
      attempt: {
        ...base, quality: good ? 'good' : 'poor', recording_id: crypto.randomUUID(),
        values: { class: clip.best, seconds: Math.round((pcm.length / AUDIO_RATE) * 10) / 10 },
        model_output: { class: clip.best, probs, windows: clip.used, clip_quality: clip.quality, ms: Math.round(clip.ms) },
      },
      pcm, saved: false, good,
      summary: good ? `Heard: ${LUNG_WORDS[clip.best!]}` : why || 'Could not judge. Record again.',
    };
  }
  if (def.type === 'temp' && data.temp) {
    return { attempt: { ...base, values: { celsius: data.temp.celsius, humidity: data.temp.humidity }, quality: 'good' }, saved: false, good: true,
      summary: `${data.temp.celsius.toFixed(1)} °C room, humidity ${data.temp.humidity.toFixed(0)}%` };
  }
  if (def.type === 'spo2' && data.spo2) {
    const good = data.spo2.quality >= 50;
    return { attempt: { ...base, values: { spo2: data.spo2.spo2, hr: data.spo2.hr, signal_quality: data.spo2.quality }, quality: good ? 'good' : 'poor' },
      saved: false, good, summary: `SpO₂ ${data.spo2.spo2}%, pulse ${data.spo2.hr}/min` };
  }
  return { attempt: { ...base, quality: 'poor' }, saved: false, good: false, summary: 'No reading. Record again.' };
}

export class Screening {
  session: ScreeningSession;
  steps: StepState[];
  /** From a thermometer, typed by the worker (the board only measures the room). */
  bodyTempC: number | null = null;
  dangerSigns: DangerSign[] = [];
  readonly simulated: boolean;

  constructor(readonly baby: Baby, dev: Gateway) {
    const now = new Date().toISOString();
    this.simulated = dev.simulated;
    this.session = {
      id: crypto.randomUUID(), baby_id: baby.id, device_id: dev.name + (dev.id ? ` ${dev.id.slice(0, 8)}` : ''),
      firmware_version: dev.simulated ? 'simulated' : dev.status ? `gw-${dev.status.fw}` : null, started_at: now, updated_at: now,
    };
    this.steps = STEPS.map((def) => ({
      def, attempts: [],
      step: { id: crypto.randomUUID(), session_id: this.session.id, type: def.type, required: def.required, status: 'pending', updated_at: now },
    }));
  }

  async start(): Promise<void> {
    await api.saveSession(this.session);
    for (const s of this.steps) await api.saveStep(s.step);
  }

  private touch<T extends { updated_at: string }>(r: T): T {
    // updated_at must move forward for last-write-wins, even within the same millisecond.
    const t = Math.max(Date.now(), Date.parse(r.updated_at) + 1);
    r.updated_at = new Date(t).toISOString();
    return r;
  }

  /** Save an attempt (recording first, so the attempt never points at nothing). */
  async saveAttempt(a: AttemptView): Promise<void> {
    try {
      if (a.pcm && a.attempt.recording_id) await api.uploadRecording(a.attempt.recording_id, a.pcm, AUDIO_RATE);
      await api.saveAttempt(a.attempt);
      a.saved = true; a.saveError = undefined;
    } catch (e) {
      a.saveError = (e as Error).message;
      throw e;
    }
  }

  async setStep(s: StepState, status: Step['status'], accepted: string | null): Promise<void> {
    s.step = this.touch({ ...s.step, status, accepted_attempt: accepted });
    await api.saveStep(s.step);
  }

  accepted(type: StepType): AttemptView | undefined {
    const s = this.steps.find((x) => x.def.type === type);
    return s?.attempts.find((a) => a.attempt.id === s.step.accepted_attempt);
  }

  step(type: StepType): StepState { return this.steps.find((x) => x.def.type === type)!; }

  result(): TriageResult {
    const num = (t: StepType, k: string) => { const v = this.accepted(t)?.attempt.values[k]; return typeof v === 'number' ? v : null; };
    const lung: Partial<Record<LungPosition, LungClass | null>> = {};
    for (const p of ['RU', 'LU', 'RL', 'LL'] as const) lung[p] = (this.accepted(`lung_${p}`)?.attempt.values.class as LungClass | undefined) ?? null;
    return triage({
      ageBand: ageBand(new Date(this.baby.date_of_birth)), breathBpm: num('breath', 'bpm'), lung, spo2: num('spo2', 'spo2'),
      bodyTempC: this.bodyTempC, dangerSigns: this.dangerSigns,
    });
  }

  async finish(): Promise<TriageResult> {
    const r = this.result();
    this.session = this.touch({ ...this.session, finished_at: new Date().toISOString(),
      result: { refer: r.refer, level: r.level, reasons: [...r.urgent, ...r.reasons], rules_version: r.rulesVersion, missing: r.missing,
        body_temp_c: this.bodyTempC, danger_signs: this.dangerSigns, simulated: this.simulated || undefined } });
    await api.saveSession(this.session);
    return r;
  }
}
