// "Simulate BLE data": a gateway that behaves like the board (status, mic level,
// record-then-send) with synthetic signals, so the app can be shown without hardware.
// Everything it produces is labelled as simulated where it is saved.
import { AUDIO_RATE, Flag, State, Step, type DeviceStatus, type StepData, type StepId } from '@pneumo/protocol';
import { Gateway, type Progress } from './ble';

const SPEED = 3;   // demo recordings run 3× faster than real time

export class SimGateway extends Gateway {
  override readonly simulated = true;
  private on_ = false;
  private t0 = Date.now();
  private tick: ReturnType<typeof setInterval> | null = null;
  private stopEarly = false;

  override get connected(): boolean { return this.on_; }

  override async connect(): Promise<void> {
    await new Promise((r) => setTimeout(r, 700));
    this.on_ = true; this.name = 'PneumoScreen (simulated)'; this.id = 'SIMULATOR';
    this.t0 = Date.now() - 4 * 60_000;
    this.push({ state: State.IDLE, step: Step.NONE, progress: 0 });
    this.tick = setInterval(() => this.status && this.push({}), 1000);
    this.setLink('connected');
  }

  override async resume(): Promise<boolean> { return false; }

  override disconnect(): void {
    if (!this.on_) return;
    this.on_ = false;
    if (this.tick) clearInterval(this.tick);
    this.listeners.forEach((l) => l.disconnect?.());
    this.setLink('disconnected');
  }

  private push(p: Partial<DeviceStatus>): void {
    const base: DeviceStatus = this.status ?? {
      proto: 1, fw: '1.0', flags: Flag.MIC_OK | Flag.IMU_OK | Flag.TEMP_OK | Flag.SPO2_OK | Flag.OLED_OK, safeMode: false,
      state: State.IDLE, step: Step.NONE, progress: 0, err: 0, framesTotal: 0, payloadMax: 237, pingToken: 0, uptimeS: 0,
    };
    this.setStatus({ ...base, ...p, uptimeS: Math.floor((Date.now() - this.t0) / 1000) });
  }

  override async ping(): Promise<number> {
    const ms = 18 + Math.round(Math.random() * 25);
    await new Promise((r) => setTimeout(r, ms));
    return ms;
  }

  override async stop(): Promise<void> { this.stopEarly = true; }

  override async record(step: StepId, seconds: number, onProgress: (p: Progress) => void): Promise<StepData> {
    if (!this.on_) throw new Error('device not connected');
    this.stopEarly = false;
    const lung = step >= Step.LUNG_RU && step <= Step.LUNG_LL;
    const ms = Math.max(600, (seconds * 1000) / SPEED);
    const start = Date.now();
    this.push({ state: State.RECORDING, step, progress: 0, err: 0 });
    let done = 0;
    while (done < 1 && !this.stopEarly) {
      await new Promise((r) => setTimeout(r, 100));
      done = Math.min(1, (Date.now() - start) / ms);
      const pct = Math.round(done * 100);
      this.push({ state: State.RECORDING, step, progress: pct });
      onProgress({ phase: 'recording', percent: pct });
      if (lung) {
        const breath = 0.5 - 0.5 * Math.cos(2 * Math.PI * ((Date.now() - start) / 1000) * SPEED / 1.4);
        const rms = 0.01 + 0.05 * breath + Math.random() * 0.01;
        this.listeners.forEach((l) => l.level?.({ rms, clipped: false }));
      }
    }
    const got = seconds * done;
    this.push({ state: State.TRANSFERRING, step, progress: 0, framesTotal: 12 });
    for (let p = 0; p <= 100; p += 20) { onProgress({ phase: 'receiving', percent: p }); await new Promise((r) => setTimeout(r, 80)); }
    this.push({ state: State.IDLE, step: Step.NONE, progress: 0, framesTotal: 0 });
    return synth(step, got);
  }
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

/** Signals shaped like the real ones: breath-modulated chest sound, belly movement. */
function synth(step: StepId, seconds: number): StepData {
  const r = rng(Date.now());
  if (step === Step.BREATH) {
    const bpm = 38 + Math.round(Math.random() * 18), n = Math.round(seconds * 10);
    const accel = new Int16Array(n * 3);
    for (let i = 0; i < n; i++) {
      const t = i / 10, z = 40 * Math.sin(2 * Math.PI * (bpm / 60) * t) + 6 * r();
      accel[i * 3] = Math.round(3 * r()); accel[i * 3 + 1] = Math.round(4 * r()); accel[i * 3 + 2] = Math.round(z);
    }
    return { step, accel, breath: { bpm, quality: 82 } };
  }
  if (step === Step.TEMP) return { step, temp: { celsius: 24.6 + Math.random(), humidity: 52 + Math.random() * 8 } };
  if (step === Step.SPO2) return { step, spo2: { spo2: 91 + Math.round(Math.random() * 7), hr: 118 + Math.round(Math.random() * 30), quality: 88 } };
  const n = Math.round(seconds * AUDIO_RATE), audio = new Int16Array(n);
  const crackles = Math.random() < 0.3;
  for (let i = 0; i < n; i++) {
    const t = i / AUDIO_RATE, breath = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 1.4);
    let v = breath * (0.18 * Math.sin(2 * Math.PI * 160 * t) + 0.12 * Math.sin(2 * Math.PI * 310 * t) + 0.2 * r()) + 0.01 * r();
    if (crackles && breath > 0.6 && i % 900 < 30) v += 0.7 * Math.exp(-(i % 900) / 6) * r();
    audio[i] = Math.max(-32768, Math.min(32767, Math.round(v * 14000)));
  }
  return { step, audio };
}
