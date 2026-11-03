import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Card({ title, icon, right, children, className = '' }: { title?: ReactNode; icon?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-5 ${className}`}>
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-50">{icon}{title}</h2>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const V: Record<Variant, string> = {
  primary: 'bg-teal-700 text-white hover:bg-teal-800 dark:bg-teal-500 dark:text-slate-950 dark:hover:bg-teal-400',
  secondary: 'border-2 border-slate-300 bg-white text-slate-800 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800',
  danger: 'bg-rose-600 text-white hover:bg-rose-700',
  ghost: 'text-teal-700 hover:bg-teal-50 dark:text-teal-400 dark:hover:bg-slate-800',
};
export function Button({ variant = 'primary', big, className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; big?: boolean }) {
  return (
    <button
      {...p}
      className={`inline-flex items-center justify-center gap-2 rounded-xl text-center font-semibold transition focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-teal-500 disabled:cursor-not-allowed disabled:opacity-45 ${big ? 'min-h-14 px-5 py-2 text-lg leading-tight' : 'min-h-11 whitespace-nowrap px-4 text-sm'} ${V[variant]} ${className}`}
    />
  );
}

type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'info';
const T: Record<Tone, string> = {
  ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  warn: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300',
  bad: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300',
  muted: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  info: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
};
export function Badge({ tone = 'muted', children, dot }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  const d = { ok: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-rose-500', muted: 'bg-slate-400', info: 'bg-sky-500' }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-semibold ${T[tone]}`}>
      {dot && <span className={`h-2 w-2 rounded-full ${d}`} />}{children}
    </span>
  );
}

export function Bar({ value, tone = 'teal' }: { value: number; tone?: 'teal' | 'amber' }) {
  return (
    <div className="h-3 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
      <div className={`h-full rounded-full transition-[width] duration-150 ${tone === 'teal' ? 'bg-teal-600 dark:bg-teal-400' : 'bg-amber-500'}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function Note({ tone = 'warn', children }: { tone?: Tone; children: ReactNode }) {
  return <div className={`rounded-xl px-3.5 py-3 text-sm ${T[tone]}`}>{children}</div>;
}
