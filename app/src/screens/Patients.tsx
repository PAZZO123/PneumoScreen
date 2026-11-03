import { useEffect, useState, type FormEvent } from 'react';
import { Baby as BabyIcon, ChevronRight, LogOut, Search, UserPlus } from 'lucide-react';
import type { Baby } from '@pneumo/server/wire';
import * as api from '../api';
import { Badge, Button, Card, Note } from '../components/ui';

export function ageText(dob: string): string {
  const d = new Date(dob), now = new Date();
  let m = (now.getFullYear() - d.getFullYear()) * 12 + now.getMonth() - d.getMonth();
  if (now.getDate() < d.getDate()) m--;
  if (m < 1) { const days = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 86_400_000)); return `${days} day${days === 1 ? '' : 's'}`; }
  return m < 24 ? `${m} month${m === 1 ? '' : 's'}` : `${Math.floor(m / 12)} years`;
}

export function Login({ onDone }: { onDone: (m: api.Me) => void }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setErr('');
    try { await api.login(String(f.get('username')).trim(), String(f.get('password'))); onDone(await api.me()); } catch (x) { setErr((x as Error).message); }
    setBusy(false);
  };
  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <div className="text-center">
        <div className="mx-auto mb-3 grid h-16 w-16 place-items-center rounded-2xl bg-teal-700 text-3xl text-white shadow-lg">🫁</div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">PneumoScreen</h1>
        <p className="text-slate-600 dark:text-slate-600">Pneumonia screening for children</p>
      </div>
      <Card>
        <form onSubmit={submit} className="space-y-4">
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Username
            <input name="username" autoComplete="username" autoCapitalize="none" required className="field" /></label>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Password
            <input name="password" type="password" autoComplete="current-password" required className="field" /></label>
          <Button big className="w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
          {err && <Note tone="bad">{err}</Note>}
        </form>
      </Card>
    </div>
  );
}

export function PatientList({ me, onPick, onSignOut }: { me: api.Me; onPick: (b: Baby) => void; onSignOut: () => void }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<api.BabyRow[] | null>(null);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => api.searchBabies(q).then((l) => { setList(l); setErr(''); }, (e) => setErr(e.message)), 200);
    return () => clearTimeout(t);
  }, [q]);
  if (adding) return <NewBaby me={me} onSaved={onPick} onCancel={() => setAdding(false)} />;
  return (
    <Card title={`Hello, ${me.name}`} icon={<BabyIcon className="h-5 w-5 text-teal-600" />}
      right={<Button variant="ghost" onClick={onSignOut}><LogOut className="h-4 w-4" />Sign out</Button>}>
      <div className="space-y-3">
        <Button big className="w-full" onClick={() => setAdding(true)}><UserPlus className="h-5 w-5" />Register a new child</Button>
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-600" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, guardian or village" aria-label="Search children" className="field mt-0 pl-10" />
        </label>
        {err && <Note tone="bad">{err}</Note>}
        {list?.length === 0 && <p className="py-6 text-center text-slate-600">No children found.</p>}
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {list?.map((b) => (
            <li key={b.id}>
              <button onClick={() => onPick(b)} className="flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-teal-100 font-bold text-teal-800 dark:bg-teal-950 dark:text-teal-300">{b.name.slice(0, 1)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-slate-900">{b.name}</span>
                  <span className="block text-sm text-slate-600">{ageText(b.date_of_birth)} · {b.village || 'no village'}</span>
                  <span className="mt-1 block">{b.incomplete_sessions ? <Badge tone="warn">unfinished</Badge> : b.last_visit
                    ? <span className="text-sm text-slate-600">seen {new Date(b.last_visit).toLocaleDateString()}</span> : <Badge>new</Badge>}</span>
                </span>
                <ChevronRight className="h-5 w-5 text-slate-600" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function NewBaby({ me, onSaved, onCancel }: { me: api.Me; onSaved: (b: Baby) => void; onCancel: () => void }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const b: Baby = {
      id: crypto.randomUUID(), updated_at: new Date().toISOString(), name: f.name.trim(), date_of_birth: f.dob,
      sex: f.sex as Baby['sex'], guardian_name: f.guardian || null, guardian_phone: f.phone || null, village: f.village || null,
      notes: f.notes || null, assigned_to: me.id,
    };
    setBusy(true); setErr('');
    try { await api.saveBaby(b); onSaved(b); } catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  const L = 'block text-sm font-medium text-slate-700 dark:text-slate-300';
  return (
    <Card title="Register a new child" icon={<UserPlus className="h-5 w-5 text-teal-600" />}>
      <form className="space-y-4" onSubmit={submit}>
        <label className={L}>Child’s full name<input name="name" required className="field" /></label>
        <label className={L}>Date of birth<input name="dob" type="date" max={new Date().toISOString().slice(0, 10)} required className="field" /></label>
        <fieldset>
          <legend className={L}>Sex</legend>
          <div className="mt-1.5 grid grid-cols-3 gap-2">
            {['female', 'male', 'unknown'].map((s) => (
              <label key={s} className="flex min-h-12 cursor-pointer items-center justify-center rounded-xl border-2 border-slate-200 font-medium capitalize has-checked:border-teal-600 has-checked:bg-teal-50 dark:border-slate-700 dark:has-checked:bg-teal-950">
                <input type="radio" name="sex" value={s} required defaultChecked={s === 'unknown'} className="sr-only" />{s}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={L}>Guardian’s name<input name="guardian" className="field" /></label>
          <label className={L}>Guardian’s phone<input name="phone" type="tel" className="field" /></label>
        </div>
        <label className={L}>Village<input name="village" className="field" /></label>
        <label className={L}>Notes<textarea name="notes" rows={2} className="field" /></label>
        {err && <Note tone="bad">{err}</Note>}
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button big className="flex-1" disabled={busy}>{busy ? 'Saving…' : 'Save and continue'}</Button>
          <Button big variant="secondary" type="button" onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}
