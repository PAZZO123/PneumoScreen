import { useEffect, useMemo, useRef } from 'react';
import { CartesianGrid, Line, LineChart, PolarAngleAxis, RadialBar, RadialBarChart, ReferenceDot, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { fft128 } from '@pneumo/dsp';

const RATE = 4000;

/** Min/max envelope of a clip, one column per pixel. */
export function Waveform({ pcm, height = 90 }: { pcm: Int16Array; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = height;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(c);
    g.strokeStyle = css.getPropertyValue('--grid').trim() || '#ccc';
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    g.fillStyle = css.color;
    const per = Math.max(1, Math.floor(pcm.length / w));
    let peak = 1;
    for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
    for (let x = 0; x < w; x++) {
      let lo = 0, hi = 0;
      for (let i = x * per, e = Math.min(pcm.length, i + per); i < e; i++) { if (pcm[i] < lo) lo = pcm[i]; if (pcm[i] > hi) hi = pcm[i]; }
      const y0 = h / 2 - (hi / peak) * (h / 2 - 2), y1 = h / 2 - (lo / peak) * (h / 2 - 2);
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }, [pcm, height]);
  return <canvas ref={ref} className="block w-full text-teal-600 [--grid:var(--color-slate-200)] dark:text-teal-400 dark:[--grid:var(--color-slate-700)]" style={{ height }} aria-label="sound waveform" />;
}

/** Log-power spectrogram, 128-point FFT with 50 % overlap (0–2 kHz). */
export function Spectrogram({ pcm, height = 110 }: { pcm: Int16Array; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const frames = useMemo(() => {
    const N = 128, hop = 64, win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
    const out: Float32Array[] = [];
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let o = 0; o + N <= pcm.length; o += hop) {
      for (let i = 0; i < N; i++) { re[i] = (pcm[o + i] / 32768) * win[i]; im[i] = 0; }
      fft128(re, im);
      const p = new Float32Array(N / 2);
      for (let k = 0; k < N / 2; k++) p[k] = 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-10);
      out.push(p);
    }
    return out;
  }, [pcm]);
  useEffect(() => {
    const c = ref.current;
    if (!c || !frames.length) return;
    const bins = frames[0].length;
    c.width = frames.length; c.height = bins;
    const g = c.getContext('2d')!, img = g.createImageData(frames.length, bins);
    let max = -Infinity;
    for (const f of frames) for (const v of f) max = Math.max(max, v);
    const min = max - 70;
    frames.forEach((f, x) => {
      for (let k = 0; k < bins; k++) {
        const t = Math.max(0, Math.min(1, (f[k] - min) / (max - min)));
        const [r, gg, b] = viridis(t), i = ((bins - 1 - k) * frames.length + x) * 4;
        img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    });
    g.putImageData(img, 0, 0);
  }, [frames]);
  return (
    <div className="relative">
      <canvas ref={ref} className="block w-full rounded-lg [image-rendering:pixelated]" style={{ height }} aria-label="spectrogram" />
      <span className="absolute left-1 top-0.5 text-sm font-medium text-white/80">2 kHz</span>
      <span className="absolute bottom-0.5 left-1 text-sm font-medium text-white/80">0</span>
      <span className="absolute bottom-0.5 right-1 text-sm font-medium text-white/80">{(pcm.length / RATE).toFixed(1)} s</span>
    </div>
  );
}
function viridis(t: number): [number, number, number] {
  const stops: Array<[number, number, number]> = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  return [0, 1, 2].map((j) => Math.round(stops[i][j] + (stops[i + 1][j] - stops[i][j]) * f)) as [number, number, number];
}

/** Belly movement at 10 Hz (the axis that moves most), with the breaths that were counted. */
export function ChestChart({ accel }: { accel: Int16Array }) {
  const { data, peaks } = useMemo(() => {
    const n = Math.floor(accel.length / 3);
    const axes = [0, 1, 2].map((a) => Array.from({ length: n }, (_, i) => accel[i * 3 + a]));
    const variance = (v: number[]) => { const m = v.reduce((s, x) => s + x, 0) / (v.length || 1); return v.reduce((s, x) => s + (x - m) ** 2, 0); };
    const y = axes.reduce((best, v) => (variance(v) > variance(best) ? v : best), axes[2]);
    const sm = y.map((_, i) => (y[Math.max(0, i - 1)] + y[i] + y[Math.min(n - 1, i + 1)]) / 3);
    const mean = sm.reduce((s, x) => s + x, 0) / (n || 1);
    const sd = Math.sqrt(sm.reduce((s, x) => s + (x - mean) ** 2, 0) / (n || 1));
    const peaks: number[] = [];
    for (let i = 1; i < n - 1; i++) {
      if (sm[i] > sm[i - 1] && sm[i] >= sm[i + 1] && sm[i] > mean + 0.3 * sd && (!peaks.length || i - peaks.at(-1)! >= 6)) peaks.push(i);
    }
    return { data: sm.map((v, i) => ({ t: i / 10, v: Math.round(v) })), peaks: peaks.map((i) => ({ t: i / 10, v: Math.round(sm[i]) })) };
  }, [accel]);
  return (
    <div>
    <div className="h-36 w-full" aria-label="chest movement">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200 dark:stroke-slate-700" />
          <XAxis dataKey="t" type="number" domain={[0, 'dataMax']} tickFormatter={(t) => `${t}s`} tick={{ fontSize: 11 }} stroke="currentColor" className="text-slate-600" />
          <YAxis tick={{ fontSize: 11 }} stroke="currentColor" className="text-slate-600" />
          <Line type="monotone" dataKey="v" dot={false} strokeWidth={2} stroke="#0d9488" isAnimationActive={false} />
          {peaks.map((p) => <ReferenceDot key={p.t} x={p.t} y={p.v} r={4} fill="#e11d48" stroke="none" />)}
        </LineChart>
      </ResponsiveContainer>
    </div>
    <p className="mt-1 text-sm text-slate-600 dark:text-slate-600">{peaks.length} breaths marked in {(data.length / 10).toFixed(0)} s (mg, smoothed)</p>
    </div>
  );
}

export function Spo2Gauge({ value }: { value: number | null }) {
  const color = value == null ? '#94a3b8' : value < 90 ? '#dc2626' : value < 95 ? '#d97706' : '#059669';
  return (
    <div className="relative mx-auto h-36 w-36">
      <ResponsiveContainer>
        <RadialBarChart innerRadius="72%" outerRadius="100%" data={[{ v: value ?? 0 }]} startAngle={210} endAngle={-30}>
          <PolarAngleAxis type="number" domain={[70, 100]} tick={false} />
          <RadialBar dataKey="v" cornerRadius={8} fill={color} background={{ fill: 'rgba(148,163,184,.25)' }} isAnimationActive={false} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className={`absolute inset-0 flex flex-col items-center justify-center ${value != null && value < 95 ? 'animate-pulse' : ''}`}>
        <span className="text-3xl font-bold tabular-nums" style={{ color }}>{value ?? '--'}<span className="text-base">%</span></span>
        <span className="text-sm text-slate-600 dark:text-slate-600">SpO₂</span>
      </div>
    </div>
  );
}

export function LevelMeter({ level, active }: { level: number; active: boolean }) {
  const ok = level > 0.12 && level < 0.9;
  return (
    <div>
      <div className="mb-1 flex justify-between text-sm font-medium text-slate-600 dark:text-slate-300">
        <span>Microphone level</span>
        <span className={active ? (ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400') : ''}>
          {active ? (ok ? 'Good contact' : level >= 0.9 ? 'Too loud' : 'Very quiet: press gently') : 'Shows while recording'}
        </span>
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
        <div className={`h-full rounded-full transition-[width] duration-100 ${level >= 0.9 ? 'bg-rose-500' : 'bg-emerald-500'}`} style={{ width: `${level * 100}%` }} />
      </div>
    </div>
  );
}

const CLASS_COLOR: Record<string, string> = { normal: 'bg-emerald-500', crackles: 'bg-rose-500', wheezes: 'bg-amber-500', noise: 'bg-slate-400' };
export function ProbBars({ probs }: { probs: Record<string, number> }) {
  return (
    <ul className="space-y-1.5">
      {Object.entries(probs).map(([k, p]) => (
        <li key={k} className="grid grid-cols-[5.5rem_1fr_2.5rem] items-center gap-2 text-sm">
          <span className="capitalize text-slate-600 dark:text-slate-300">{k}</span>
          <span className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"><span className={`block h-full ${CLASS_COLOR[k] ?? 'bg-teal-500'}`} style={{ width: `${p * 100}%` }} /></span>
          <span className="text-right tabular-nums text-slate-600 dark:text-slate-300">{Math.round(p * 100)}%</span>
        </li>
      ))}
    </ul>
  );
}
