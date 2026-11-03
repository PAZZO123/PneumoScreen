// The one device the app talks to: the real gateway over Bluetooth, or the simulator.
import { useEffect, useState } from 'react';
import { Gateway, type DeviceStatus, type Link } from './ble';
import { SimGateway } from './sim';

export let gateway: Gateway = localStorage.getItem('ps_demo') === '1' ? new SimGateway() : new Gateway();
const switchers = new Set<() => void>();

export function setSimulated(on: boolean): void {
  if (on === gateway.simulated) return;
  gateway.disconnect();
  gateway = on ? new SimGateway() : new Gateway();
  try { localStorage.setItem('ps_demo', on ? '1' : '0'); } catch { /* private mode */ }
  switchers.forEach((f) => f());
}

/** Re-renders on status and link changes, and when the real/simulated device is swapped. */
export function useDevice(): { gw: Gateway; status: DeviceStatus | null; connected: boolean; link: Link } {
  const [, bump] = useState(0);
  const [gw, setGw] = useState(gateway);
  useEffect(() => {
    const swap = () => setGw(gateway);
    switchers.add(swap);
    return () => { switchers.delete(swap); };
  }, []);
  useEffect(() => gw.on({ status: () => bump((n) => n + 1), disconnect: () => bump((n) => n + 1), link: () => bump((n) => n + 1) }), [gw]);
  return { gw, status: gw.connected ? gw.status : null, connected: gw.connected, link: gw.link };
}

/** Live mic level 0..1 (sqrt-scaled RMS), 0 when idle. */
export function useLevel(): number {
  const { gw } = useDevice();
  const [level, setLevel] = useState(0);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const off = gw.on({ level: (l) => { setLevel(Math.min(1, Math.sqrt(l.rms) * 2.2)); clearTimeout(t); t = setTimeout(() => setLevel(0), 600); } });
    return () => { off(); clearTimeout(t); };
  }, [gw]);
  return level;
}
