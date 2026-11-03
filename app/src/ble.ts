// Bluetooth link to the PneumoScreen gateway (docs/BLE_PROTOCOL.md).
// Web Bluetooth in Chrome now; the Capacitor build will swap the transport.
import {
  DEVICE_NAME, Err, Flag, State, Step, StepAssembler, UUID, doneAck, parseFrame, parseLevel, parseStatus, ping, resend, startStep,
  type DeviceStatus, type Level, type StepData, type StepId,
} from '@pneumo/protocol';

export { Flag, State, Step };
export type { DeviceStatus, StepData };

export const ERROR_TEXT: Record<number, string> = {
  [Err.NONE]: 'none', [Err.BAD_CMD]: 'the board did not understand the command', [Err.NO_SENSOR]: 'the sensor for this step was not found',
  [Err.NO_MEMORY]: 'the board ran out of memory', [Err.BUSY]: 'the board is busy', [Err.TOO_LONG]: 'the recording is too long',
};

export const SENSORS: Array<{ flag: number; name: string; use: string; optional?: boolean }> = [
  { flag: Flag.MIC_OK, name: 'Microphone', use: 'lung sounds' },
  { flag: Flag.IMU_OK, name: 'Motion sensor', use: 'breathing rate' },
  { flag: Flag.TEMP_OK, name: 'Temperature', use: 'room temperature', optional: true },
  { flag: Flag.SPO2_OK, name: 'Pulse oximeter', use: 'oxygen (SpO₂)', optional: true },
  { flag: Flag.OLED_OK, name: 'Screen', use: 'board display', optional: true },
];

export interface Progress { phase: 'recording' | 'receiving' | 'checking'; percent: number }

export type Link = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
type Listener = { status?: (s: DeviceStatus) => void; level?: (l: Level) => void; disconnect?: () => void; link?: (l: Link) => void };

const FILTERS: BluetoothLEScanFilter[] = [{ services: [UUID.service] }, { name: DEVICE_NAME }];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);
}

export class Gateway {
  status: DeviceStatus | null = null;
  name = DEVICE_NAME;
  id = '';
  link: Link = 'disconnected';
  protected device: BluetoothDevice | null = null;
  private control: BluetoothRemoteGATTCharacteristic | null = null;
  protected listeners = new Set<Listener>();
  private asm: StepAssembler | null = null;
  private onFrame: (() => void) | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private wantLink = false;   // false after the worker presses Disconnect

  static supported(): string | null {
    if (!('bluetooth' in navigator)) return 'This browser cannot use Bluetooth. Use Chrome or Edge.';
    if (!window.isSecureContext) return 'Bluetooth needs http://localhost or HTTPS.';
    return null;
  }

  readonly simulated: boolean = false;

  get connected(): boolean { return !!this.device?.gatt?.connected && !!this.control; }

  on(l: Listener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }

  protected setLink(l: Link): void { this.link = l; this.listeners.forEach((x) => x.link?.(l)); }

  /** Pick a device in Chrome's list (needs a tap), then stay connected to it. */
  async connect(): Promise<void> {
    const device = await navigator.bluetooth.requestDevice({ filters: FILTERS, optionalServices: [UUID.service] });
    this.wantLink = true;
    this.setLink('connecting');
    try { await this.attach(device); } catch (e) { this.setLink('disconnected'); throw e; }
  }

  /**
   * Reconnect without the list to a board this browser was allowed before
   * (Chrome remembers it). Returns false when there is none or it is out of range.
   */
  async resume(): Promise<boolean> {
    if (this.connected || !navigator.bluetooth?.getDevices) return this.connected;
    const known = (await navigator.bluetooth.getDevices().catch(() => [])).filter((d) => !d.name || d.name.startsWith(DEVICE_NAME));
    if (!known.length) return false;
    this.wantLink = true;
    this.device = known[0];
    this.keepAlive(known[0]);
    return true;
  }

  private async attach(device: BluetoothDevice): Promise<void> {
    if (this.device !== device) {
      device.addEventListener('gattserverdisconnected', () => {
        this.control = null;
        this.listeners.forEach((l) => l.disconnect?.());
        if (this.wantLink) this.keepAlive(device); else this.setLink('disconnected');
      });
    }
    this.device = device;
    const server = await withTimeout(device.gatt!.connect(), 10_000, 'connecting');
    const svc = await server.getPrimaryService(UUID.service);
    const control = await svc.getCharacteristic(UUID.control);
    const status = await svc.getCharacteristic(UUID.status);
    const data = await svc.getCharacteristic(UUID.data);
    const level = await svc.getCharacteristic(UUID.level);
    status.addEventListener('characteristicvaluechanged', () => this.setStatus(parseStatus(status.value!)));
    level.addEventListener('characteristicvaluechanged', () => { const l = parseLevel(level.value!); this.listeners.forEach((x) => x.level?.(l)); });
    data.addEventListener('characteristicvaluechanged', () => { if (this.asm?.add(parseFrame(data.value!))) this.onFrame?.(); });
    await status.startNotifications();
    await data.startNotifications();
    await level.startNotifications();
    this.control = control; this.writes = Promise.resolve();
    this.name = device.name || DEVICE_NAME; this.id = device.id;
    this.setStatus(parseStatus(await status.readValue()));
    this.setLink('connected');
  }

  /** Hot reconnect: keep trying while the board is reset, switched off or out of range. */
  private reconnecting = false;
  private async keepAlive(device: BluetoothDevice): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.setLink('reconnecting');
    // Where Chrome supports it, wait for the board to advertise instead of guessing.
    const seen = () => new Promise<void>((res) => {
      if (!device.watchAdvertisements) return res();
      const on = () => { device.removeEventListener('advertisementreceived', on); res(); };
      device.addEventListener('advertisementreceived', on);
      device.watchAdvertisements().catch(() => res());
      setTimeout(on, 6000);   // try anyway every few seconds
    });
    for (let n = 0; this.wantLink && !this.connected; n++) {
      await seen();
      if (!this.wantLink) break;
      try { await this.attach(device); } catch { await wait(Math.min(5000, 1000 + n * 500)); }
    }
    this.reconnecting = false;
    if (!this.connected) this.setLink('disconnected');
  }

  disconnect(): void {
    this.wantLink = false;
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.setLink('disconnected');
  }

  has(flag: number): boolean { return !!this.status && (this.status.flags & flag) !== 0; }

  protected setStatus(s: DeviceStatus): void { this.status = s; this.listeners.forEach((l) => l.status?.(s)); }

  /** One GATT write at a time: Chrome refuses a second while one is in flight. */
  private write(b: Uint8Array): Promise<void> {
    const control = this.control;
    if (!control) return Promise.reject(new Error('device not connected'));
    const next = this.writes.then(() => control.writeValueWithResponse(b.slice()));   // copy: plain ArrayBuffer view
    this.writes = next.catch(() => {});
    return next;
  }

  /** Round trip in ms: the board echoes the token in its next status. */
  async ping(): Promise<number> {
    const token = (Math.random() * 2 ** 32) >>> 0;
    const t0 = performance.now();
    const echoed = this.waitStatus((s) => s.pingToken === token, 3000);
    await this.write(ping(token));
    await echoed;
    return Math.round(performance.now() - t0);
  }

  private waitStatus(pred: (s: DeviceStatus) => boolean, ms: number): Promise<DeviceStatus> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('the board did not answer')); }, ms);
      const off = this.on({ status: (s) => { if (pred(s)) { clearTimeout(timer); off(); resolve(s); } } });
    });
  }

  /**
   * Record one step and bring it over complete: the board records, sends numbered
   * frames and END; missing frames are asked for again; the CRC must match.
   */
  async record(step: StepId, seconds: number, onProgress: (p: Progress) => void): Promise<StepData> {
    if (this.asm) throw new Error('already recording');
    const asm = new StepAssembler(step);
    this.asm = asm;
    try {
      return await new Promise<StepData>((resolve, reject) => {
        let sent = false, started = false, transferring = false, asks = 0, done = false;
        let timer: ReturnType<typeof setTimeout>, quiet: ReturnType<typeof setTimeout>;
        const arm = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => finish(new Error('the device stopped answering')), ms); };
        const finish = (err: Error | null, data?: StepData) => {
          if (done) return;
          done = true; clearTimeout(timer); clearTimeout(quiet); off(); this.onFrame = null;
          console.info('[ble] step', step, err ? `failed: ${err.message}` : 'complete', { received: asm.received, expected: asm.expected, asks });
          err ? reject(err) : resolve(data!);
        };
        // Ask again for every frame still missing. Before END arrives the total comes from
        // the board's status, and END itself (seq = total) is asked for too.
        let lastAsk = 0;
        const askMissing = (why: string) => {
          if (done || !transferring || Date.now() - lastAsk < 1200) return;   // let the last request arrive first
          const total = asm.expected ?? this.status?.framesTotal ?? 0;
          if (!total) return;
          const gaps = asm.missing(total);
          if (!asm.endSeen) {
            const last = gaps.at(-1);
            if (last && last[1] === total - 1) last[1] = total; else gaps.push([total, total]);
          }
          if (!gaps.length) return;
          if (++asks > 8) return finish(new Error(`${gaps.length} part(s) of the data never arrived; record again`));
          lastAsk = Date.now();
          console.info('[ble] resend', why, gaps);
          onProgress({ phase: 'checking', percent: 100 });
          // The board queues up to 8 ranges; ask for the first ones, the rest on the next round.
          gaps.slice(0, 8).forEach(([a, b]) => void this.write(resend(a, b)).catch((e) => finish(e)));
          arm(6000);
          clearTimeout(quiet); quiet = setTimeout(() => askMissing('still missing'), 1500);
        };
        const check = () => {
          if (!asm.endSeen || asm.missing().length) return;
          if (!asm.complete()) return finish(new Error('the data was damaged on the way (CRC); record again'));
          void this.write(doneAck()).then(() => finish(null, asm.result()), (e) => finish(e));
        };
        this.onFrame = () => {
          transferring = true;
          arm(6000);
          clearTimeout(quiet); quiet = setTimeout(() => askMissing('frames stopped'), 1000);
          const exp = asm.expected ?? this.status?.framesTotal ?? 0;
          if (exp) onProgress({ phase: 'receiving', percent: Math.min(100, Math.round((asm.received * 100) / exp)) });
          if (asm.endSeen && asm.missing().length) askMissing('gap before END');
          else check();
        };
        const off = this.on({
          status: (s) => {
            if (!sent || done) return;   // older status, from before START_STEP
            if (s.state === State.RECORDING) { started = true; onProgress({ phase: 'recording', percent: s.progress }); }
            if (s.state === State.TRANSFERRING || s.state === State.HOLDING) { started = true; transferring = true; arm(6000); }
            // HOLDING = the board has sent everything and waits for DONE_ACK.
            if (s.state === State.HOLDING && !asm.complete()) askMissing('board is holding');
            if (s.state === State.ERROR || (s.err && s.step === Step.NONE)) finish(new Error(ERROR_TEXT[s.err] ?? `device error ${s.err}`));
            else if (started && s.state === State.IDLE && !asm.endSeen) finish(new Error('the board stopped without sending data'));
          },
          disconnect: () => finish(new Error('the device disconnected; connect again and record this step again')),
        });
        arm((seconds + 8) * 1000);
        this.write(startStep(step, seconds)).then(() => { sent = true; }, (e) => finish(e));
      });
    } finally {
      this.asm = null;
    }
  }

  stop(): Promise<void> { return this.write(Uint8Array.of(0x02)); }
}

