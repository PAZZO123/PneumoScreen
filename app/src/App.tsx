import { useEffect, useRef, useState } from 'react';
import { Activity, Cloud, CloudOff } from 'lucide-react';
import type { Baby } from '@pneumo/server/wire';
import * as api from './api';
import { gateway, useDevice, useLevel } from './device';
import { useLastCapture } from './recorder';
import { loadModel } from './screening';
import { ChestChart, LevelMeter, Spectrogram, Waveform } from './components/Charts';
import { DeviceChip, DevicePanel } from './components/DevicePanel';
import { Card } from './components/ui';
import { Login, PatientList } from './screens/Patients';
import { Wizard } from './screens/Wizard';

export function App() {
  const [me, setMe] = useState<api.Me | null>(null);
  const [checking, setChecking] = useState(api.hasToken());
  const [baby, setBaby] = useState<Baby | null>(null);
  const deviceRef = useRef<HTMLElement>(null);
  const { gw, connected } = useDevice();

  useEffect(() => {
    api.setSignedOutHandler(() => setMe(null));
    if (api.hasToken()) api.me().then(setMe).catch(() => {}).finally(() => setChecking(false));
    void loadModel().catch(() => {});   // warm up the lung model
  }, []);

  if (checking) return <div className="grid min-h-screen place-items-center text-slate-600">Loading…</div>;
  if (!me) return <Login onDone={setMe} />;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 bg-teal-800 pt-[env(safe-area-inset-top)] text-white shadow dark:bg-teal-900">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-2.5">
          <button className="flex items-center gap-2 text-lg font-bold" onClick={() => setBaby(null)}>
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-white/15">🫁</span><span className="hidden min-[430px]:inline">PneumoScreen</span>
          </button>
          <div className="flex items-center gap-2">
            <ServerDot />
            <DeviceChip onClick={() => deviceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} />
          </div>
        </div>
      </header>
      {gw.simulated && <div className="bg-sky-600 px-4 py-1.5 text-center text-sm font-semibold text-white">Demo mode: the device data is simulated</div>}
      <main className="mx-auto grid max-w-7xl gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-4">
          {baby ? <Wizard key={baby.id} baby={baby} onExit={() => setBaby(null)} />
            : <PatientList me={me} onPick={setBaby} onSignOut={async () => { await api.logout(); gateway.disconnect(); setMe(null); }} />}
        </div>
        {/* On a phone the device comes first until it is connected. */}
        <aside ref={deviceRef} className={`min-w-0 scroll-mt-20 space-y-4 lg:sticky lg:top-20 lg:self-start ${connected ? '' : 'order-first lg:order-none'}`}>
          <DevicePanel />
          <SensorMonitor />
        </aside>
      </main>
    </div>
  );
}

/** Clinic server reachable? Checked every 10 s. */
function ServerDot() {
  const [up, setUp] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const check = () => api.online().then((v) => alive && setUp(v));
    check();
    const t = setInterval(check, 10_000);
    window.addEventListener('online', check); window.addEventListener('offline', check);
    return () => { alive = false; clearInterval(t); window.removeEventListener('online', check); window.removeEventListener('offline', check); };
  }, []);
  if (up === null) return null;
  return (
    <span title={up ? 'Clinic server reachable' : 'Clinic server not reachable: results will not save'}
      className={`inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 text-sm font-semibold ${up ? 'bg-white/15 text-white' : 'bg-rose-500 text-white'}`}>
      {up ? <Cloud className="h-4 w-4" /> : <CloudOff className="h-4 w-4" />}
      <span className={up ? 'sr-only sm:not-sr-only' : ''}>{up ? 'Server' : 'Offline'}</span>
    </span>
  );
}

/** Live mic level while recording, then the last recording the device sent. */
function SensorMonitor() {
  const level = useLevel();
  const { status } = useDevice();
  const cap = useLastCapture();
  const recording = status?.state === 1 && status.step >= 2 && status.step <= 5;   // lung steps use the mic
  return (
    <Card title="Sensor monitor" icon={<Activity className="h-5 w-5 text-teal-600" />}>
      <div className="space-y-4">
        <LevelMeter level={level} active={recording} />
        {cap?.pcm && <div className="space-y-2"><h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600">Last lung sound · {cap.type.slice(5)}</h3>
          <Waveform pcm={cap.pcm} height={64} /><Spectrogram pcm={cap.pcm} height={80} /></div>}
        {cap?.accel && <div><h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-600">Last chest movement</h3><ChestChart accel={cap.accel} /></div>}
        {!cap && <p className="text-sm text-slate-600">Recordings appear here after the device sends them.</p>}
      </div>
    </Card>
  );
}
