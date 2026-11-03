import { useEffect, useState } from 'react';
import { Activity, Bluetooth, BluetoothOff, ChevronDown, Cpu, FlaskConical, Loader2, Radio, Timer } from 'lucide-react';
import { ERROR_TEXT, Gateway, SENSORS, State } from '../ble';
import { setSimulated, useDevice } from '../device';
import { Badge, Button, Card, Note } from './ui';
import { Oled } from './Oled';

const STATE_TEXT = ['Ready', 'Recording', 'Sending data', 'Holding data', 'Error'];
const uptime = (s: number) => (s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`);

/** Compact status for the header. */
export function DeviceChip({ onClick }: { onClick: () => void }) {
  const { status, connected, gw, link } = useDevice();
  const missing = status ? SENSORS.filter((x) => !x.optional && !(status.flags & x.flag)).length : 0;
  const tone = link === 'reconnecting' || link === 'connecting' ? 'bg-amber-400 animate-pulse' : !connected ? 'bg-rose-400' : missing || status?.safeMode ? 'bg-amber-400' : 'bg-emerald-400';
  return (
    <button onClick={onClick} className="inline-flex min-h-10 items-center gap-2 whitespace-nowrap rounded-full bg-white/15 px-3.5 text-sm font-semibold text-white hover:bg-white/25">
      <span className={`h-2.5 w-2.5 rounded-full ${tone} ${connected ? 'shadow-[0_0_0_3px_rgba(52,211,153,.3)]' : ''}`} />
      {link === 'reconnecting' ? 'Reconnecting…' : connected ? (gw.simulated ? 'Demo device' : missing ? 'Check sensors' : 'Connected') : 'No device'}
    </button>
  );
}

export function DevicePanel() {
  const { gw, status, connected, link } = useDevice();
  const [busy, setBusy] = useState(false);
  // Hot connect: reconnect to a board this browser already paired with, without the list.
  useEffect(() => { void gw.resume(); }, [gw]);
  const [err, setErr] = useState('');
  const [ping, setPing] = useState('');
  // Phones: once connected, show one summary line; details on request.
  const [open, setOpen] = useState(() => window.matchMedia('(min-width: 1024px)').matches);
  const unsupported = gw.simulated ? null : Gateway.supported();

  const connect = async () => {
    setBusy(true); setErr(''); setPing('');
    try { await gw.connect(); } catch (e) {
      const x = e as Error;
      setErr(x.name === 'NotFoundError' ? 'No device chosen. Is it on and near? Try again.' : x.message);
    }
    setBusy(false);
  };
  const doPing = async () => { setPing('…'); try { setPing(`${await gw.ping()} ms`); } catch (e) { setPing((e as Error).message); } };

  return (
    <Card title="PneumoScreen gateway" icon={<Cpu className="h-5 w-5 text-teal-600" />}
      right={<label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-600 dark:text-slate-300">
        <FlaskConical className="h-4 w-4" />Simulate BLE data
        <input type="checkbox" className="h-5 w-5 accent-teal-600" checked={gw.simulated} onChange={(e) => setSimulated(e.target.checked)} />
      </label>}>
      <div className="space-y-4">
        {link === 'reconnecting' ? (
          <div className="space-y-3">
            <Note tone="warn"><span className="flex items-center gap-2 font-semibold"><Loader2 className="h-5 w-5 animate-spin" />Looking for {gw.name}…</span>
              It connects by itself when the device is on and near.</Note>
            <Button variant="secondary" className="w-full" onClick={() => gw.disconnect()}>Stop</Button>
          </div>
        ) : !connected ? (
          <>
            {unsupported ? <Note tone="bad">{unsupported}</Note> : (
              <Button big className="w-full" onClick={connect} disabled={busy}>
                {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Bluetooth className="h-5 w-5" />}
                {busy ? 'Connecting…' : gw.simulated ? 'Connect simulated gateway' : 'Connect PneumoScreen Gateway'}
              </Button>
            )}
            {!gw.simulated && <p className="text-sm text-slate-600 dark:text-slate-600">Turn the device on. Choose <b>PneumoScreen</b> in the list.</p>}
            {err && <Note tone="bad">{err}</Note>}
          </>
        ) : status && (() => {
          const ok = SENSORS.filter((x) => !x.optional || status.flags & x.flag);
          const okCount = ok.filter((x) => status.flags & x.flag).length;
          return (
          <>
            <button onClick={() => setOpen(!open)} aria-expanded={open}
              className="flex w-full items-center gap-3 rounded-xl bg-emerald-50 p-3 text-left ring-1 ring-emerald-200">
              <span className="relative grid h-11 w-11 shrink-0 place-items-center rounded-full bg-emerald-600 text-white">
                <Bluetooth className="h-5 w-5" /><span className="absolute -right-0.5 -top-0.5 h-3.5 w-3.5 rounded-full bg-emerald-400 ring-2 ring-white" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-slate-900">{gw.name}</span>
                <span className="block text-sm text-slate-700">
                  {STATE_TEXT[status.state] ?? 'Unknown'}{status.state === State.RECORDING || status.state === State.TRANSFERRING ? ` ${status.progress}%` : ''}
                  {' · '}{okCount}/{ok.length} sensors OK
                </span>
              </span>
              <ChevronDown className={`h-5 w-5 shrink-0 text-slate-600 transition ${open ? 'rotate-180' : ''}`} />
            </button>
            {status.safeMode && <Note>Safe mode: some sensors are off. Press reset on the device.</Note>}
            {status.err !== 0 && <Note tone="bad">Last problem: {ERROR_TEXT[status.err] ?? status.err}</Note>}
            <div className="flex flex-wrap gap-2">
              {SENSORS.map((x) => {
                const on = (status.flags & x.flag) !== 0;
                return <Badge key={x.name} dot tone={on ? 'ok' : x.optional ? 'muted' : 'bad'}>{x.name}{on ? '' : ' missing'}</Badge>;
              })}
            </div>
            {open && <>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                {[
                  [<Timer key="t" className="h-4 w-4" />, 'Uptime', uptime(status.uptimeS)],
                  [<Cpu key="c" className="h-4 w-4" />, 'Firmware', `${status.fw} · v${status.proto}`],
                  [<Radio key="r" className="h-4 w-4" />, 'MTU', status.payloadMax ? `${status.payloadMax + 7} bytes` : '—'],
                  [<Activity key="a" className="h-4 w-4" />, 'Ping', <button key="p" className="font-semibold text-teal-700 underline" onClick={doPing}>{ping || 'Test'}</button>],
                ].map(([ic, k, v], i) => (
                  <div key={i} className="rounded-xl bg-slate-50 p-2.5">
                    <dt className="flex items-center gap-1.5 text-sm text-slate-600">{ic}{k}</dt>
                    <dd className="font-semibold tabular-nums text-slate-900">{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-sm text-slate-600">Battery: not reported by the device.</p>
              <Button variant="secondary" className="w-full" onClick={() => gw.disconnect()}><BluetoothOff className="h-4 w-4" />Disconnect</Button>
            </>}
          </>
          );
        })()}
        {(open || !connected) && <Oled />}
      </div>
    </Card>
  );
}
