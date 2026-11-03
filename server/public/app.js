// PneumoScreen laptop dashboard (no build step). Data is only ever inserted
// via textContent or esc(), so names and notes can't inject markup.
'use strict';

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (s) => (s ? new Date(s).toLocaleString() : '—');
const fmtDay = (s) => (s ? new Date(s).toLocaleDateString() : '—');
const STEP_LABEL = { breath: 'Breath', lung_RU: 'Lung R-up', lung_LU: 'Lung L-up', lung_RL: 'Lung R-low', lung_LL: 'Lung L-low', temp: 'Temp', spo2: 'SpO₂' };

let token = sessionStorage.getItem('ps_token');
let me = null;
let liveWs = null;
let backView = 'overview';
let sessionCtx = null;      // { id, baby, worker } of the open session view
let audioUrls = [];         // blob: URLs to revoke when leaving the session view

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
  });
  if (res.status === 401) { signOut(); throw new Error('signed out'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

function show(view) {
  for (const id of ['login', 'overview', 'babies', 'baby', 'session', 'users', 'live']) $(`#${id}`).hidden = id !== view;
  if (view !== 'live' && liveWs) { liveWs.close(); liveWs = null; }
  if (view !== 'session' && view !== 'live') { audioUrls.forEach((u) => URL.revokeObjectURL(u)); audioUrls = []; }
}

function table(headers, rows, onClick) {
  if (!rows.length) return '<p class="muted">Nothing yet.</p>';
  const head = `<tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>`;
  const body = rows.map((r, i) => `<tr class="${onClick ? 'click' : ''}" data-i="${i}">${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<table>${head}${body}</table>`;
}
function bindRows(container, items, fn) {
  container.querySelectorAll('tr[data-i]').forEach((tr) => tr.addEventListener('click', () => fn(items[Number(tr.dataset.i)])));
}
// Triage from the app: danger (refer now), refer (today), normal. Older records only have `refer`.
const levelOf = (level, refer) => level ?? (refer == null ? null : refer ? 'refer' : 'normal');
const levelTag = (level, refer) => ({
  danger: '<span class="tag danger">Danger</span>', refer: '<span class="tag refer">Refer</span>', normal: '<span class="tag ok">Normal</span>',
}[levelOf(level, refer)] ?? '<span class="muted">—</span>');
const demoTag = (on) => (on ? ' <span class="tag demo">demo</span>' : '');
const DANGER_SIGN = { cannot_drink: 'Not able to drink or breastfeed', vomits_all: 'Vomits everything', convulsions: 'Convulsions',
  lethargic: 'Lethargic or unconscious', chest_indrawing: 'Chest indrawing', stridor: 'Stridor when calm' };
const fmtTemp = (t) => (typeof t === 'number' ? `${t.toFixed(1)} °C${t >= 38 ? ' <span class="refer">fever</span>' : ''}` : '—');
const steps = (list) => list.map((t) => esc(STEP_LABEL[t] || t)).join(', ');

// ── auth ──
function signOut() {
  if (token) fetch('/api/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => {});
  token = null; me = null;
  sessionStorage.removeItem('ps_token');
  $('#nav').hidden = true;
  show('login');
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#login-error').textContent = '';
  try {
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: f.get('username'), password: f.get('password') }) });
    token = r.token;
    sessionStorage.setItem('ps_token', token);
    e.target.reset();
    await start();
  } catch (err) { $('#login-error').textContent = err.message; }
});
$('#logout').addEventListener('click', signOut);
const VIEWS = { overview: () => loadOverview(), babies: () => loadBabies(), users: () => loadUsers() };
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => VIEWS[b.dataset.view]()));

// ── overview ──
async function loadOverview() {
  show('overview');
  backView = 'overview';
  const qs = new URLSearchParams();
  if ($('#from').value) qs.set('from', $('#from').value);
  if ($('#to').value) qs.set('to', new Date(new Date($('#to').value).getTime() + 86400000).toISOString().slice(0, 10));
  if ($('#demo').checked) qs.set('demo', '1');
  const o = await api(`/api/analytics/overview?${qs}`);
  const t = o.totals;
  const stats = [
    ['Babies', t.babies], ['Screened', t.babies_screened], ['Screenings', t.sessions], ['Complete', t.complete],
    ['Incomplete', t.incomplete], ['Danger', t.danger ?? 0, 'danger'], ['Referred', t.referred, 'refer'],
    ['Refer rate', t.refer_rate == null ? '—' : `${Math.round(t.refer_rate * 100)}%`],
  ];
  $('#totals').innerHTML = stats.map(([k, v, tone]) => `<div class="stat ${tone ?? ''}"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');
  $('#demo-note').hidden = !o.demo_sessions;
  $('#demo-note').textContent = o.demo_sessions ? `${o.demo_sessions} demo screening${o.demo_sessions === 1 ? ' is' : 's are'} left out of these numbers.` : '';
  $('#follow-up').innerHTML = table(['Baby', 'Started', 'Worker', 'Missing steps'],
    o.follow_up.map((r) => [esc(r.baby_name) + demoTag(r.simulated), esc(fmtDate(r.started_at)), esc(r.worker), `<span class="warn">${steps(r.missing) || 'steps not started'}</span>`]), true);
  bindRows($('#follow-up'), o.follow_up, (r) => openSession(r.session_id, { baby: r.baby_name, worker: r.worker }));
  $('#per-day').innerHTML = table(['Day', 'Screenings', 'Referred', 'Danger'], o.per_day.map((r) => [esc(r.day), esc(r.sessions), esc(r.referred ?? 0),
    r.danger ? `<span class="danger-text">${esc(r.danger)}</span>` : '0']));
  $('#per-worker').innerHTML = table(['Worker', 'Screenings', 'Complete', 'Referred'], o.per_worker.map((r) => [esc(r.worker), esc(r.sessions), esc(r.complete), esc(r.referred ?? 0)]));
  $('#devices').innerHTML = table(['Device', 'Firmware', 'Last seen', 'Last worker'], o.devices.map((d) => [esc(d.device_id), esc(d.firmware_version), esc(fmtDate(d.last_seen)), esc(d.last_worker)]));
}
$('#refresh').addEventListener('click', loadOverview);
$('#demo').addEventListener('change', loadOverview);

// ── babies ──
async function loadBabies(q = $('#q').value) {
  show('babies');
  backView = 'babies';
  const list = await api('/api/babies/search', { method: 'POST', body: JSON.stringify({ q }) });
  $('#baby-list').innerHTML = table(['Name', 'Date of birth', 'Village', 'Guardian', 'Last visit', 'Incomplete'],
    list.map((b) => [esc(b.name), esc(b.date_of_birth), esc(b.village), esc(b.guardian_name), esc(fmtDay(b.last_visit)),
      b.incomplete_sessions ? `<span class="warn">${esc(b.incomplete_sessions)}</span>` : '0']), true);
  bindRows($('#baby-list'), list, (b) => loadBaby(b.id));
}
$('#search').addEventListener('submit', (e) => { e.preventDefault(); loadBabies(); });

function sparkline(points, unit) {
  if (!points.length) return '<p class="muted">No readings yet.</p>';
  const w = 300, h = 110, pad = 18;
  const vals = points.map((p) => p.value);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = (i) => pad + (points.length === 1 ? (w - 2 * pad) / 2 : (i * (w - 2 * pad)) / (points.length - 1));
  const y = (v) => h - pad - ((v - lo) / span) * (h - 2 * pad);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const dots = points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3"><title>${esc(fmtDay(p.at))}: ${esc(p.value)}${esc(unit)}</title></circle>`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="trend"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2"/>
    <g fill="currentColor">${dots}</g><text x="${pad}" y="12" font-size="11" fill="currentColor">${esc(hi)}${esc(unit)}</text>
    <text x="${pad}" y="${h - 2}" font-size="11" fill="currentColor">${esc(lo)}${esc(unit)}</text></svg>`;
}

async function loadBaby(id) {
  show('baby');
  const [b, a] = await Promise.all([api(`/api/babies/${id}`), api(`/api/analytics/baby/${id}`)]);
  $('#baby-name').textContent = b.name;
  const det = [['Date of birth', b.date_of_birth], ['Sex', b.sex], ['Guardian', b.guardian_name], ['Phone', b.guardian_phone], ['Village', b.village], ['Notes', b.notes]];
  $('#baby-details').innerHTML = det.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v || '—')}</dd>`).join('');
  $('#trend-breath').innerHTML = sparkline(a.trends.breath_bpm, '');
  $('#trend-spo2').innerHTML = sparkline(a.trends.spo2, '%');
  $('#trend-temp').innerHTML = sparkline(a.trends.body_temp_c ?? [], '°');
  const lungCell = (c) => (c == null ? '<span class="muted">—</span>' : c === 'normal' ? esc(c) : `<span class="${c === 'noise' ? 'warn' : 'refer'}">${esc(c)}</span>`);
  const visits = [...a.visits].reverse();
  $('#visits').innerHTML = table(['Date', 'Worker', 'Result', 'Breath', 'R-up', 'L-up', 'R-low', 'L-low', 'SpO₂', 'Temp', 'Status'],
    visits.map((v) => [esc(fmtDate(v.started_at)) + demoTag(v.simulated), esc(v.worker), levelTag(v.level, v.refer), esc(v.breath_bpm ?? '—'),
      lungCell(v.lung.RU), lungCell(v.lung.LU), lungCell(v.lung.RL), lungCell(v.lung.LL), esc(v.spo2 ?? '—'), fmtTemp(v.body_temp_c),
      v.status === 'complete' ? '<span class="ok">complete</span>' : `<span class="warn">missing: ${steps(v.missing)}</span>`]), true);
  bindRows($('#visits'), visits, (v) => openSession(v.session_id, { baby: b.name, worker: v.worker, babyId: id }));
}

// ── session detail ──
const STEP_ORDER = Object.keys(STEP_LABEL);
const fmtValues = (v) => Object.entries(v || {}).map(([k, x]) => `${esc(k)}: ${esc(x)}`).join('<br>') || '<span class="muted">—</span>';
function fmtModel(m) {
  if (!m) return '<span class="muted">—</span>';
  const probs = m.probs ? Object.entries(m.probs).map(([k, p]) => `<span>${esc(k)} ${Math.round(Number(p) * 100)}%</span>`).join(' ') : '';
  return `<b>${esc(m.class ?? '')}</b>${probs ? `<div class="probs muted">${probs}</div>` : ''}`;
}
const stepStatus = (s) => `<span class="${s === 'done' ? 'ok' : s === 'pending' ? 'muted' : 'warn'}">${esc(s)}</span>`;

async function openSession(sessionId, ctx = {}) {
  show('session');
  sessionCtx = { id: sessionId, ...ctx };
  const { session: s, steps: st, attempts } = await api(`/api/sessions/${sessionId}`);
  $('#session-title').textContent = `${ctx.baby || 'Screening'} — ${fmtDate(s.started_at)}`;
  const r = s.result;
  const det = [
    ['Health worker', esc(ctx.worker || '—')], ['Device', esc(s.device_id || '—')], ['Firmware', esc(s.firmware_version || '—')],
    ['Started', esc(fmtDate(s.started_at))], ['Finished', esc(fmtDate(s.finished_at))],
    ['Status', s.status === 'complete' ? '<span class="ok">complete</span>' : '<span class="warn">incomplete</span>'],
    ['Result', r ? `${levelTag(r.level, r.refer)} ${r.reasons?.length ? esc(r.reasons.join('; ')) : ''}` : '<span class="muted">no result yet</span>'],
    ['Danger signs', r?.danger_signs?.length ? `<span class="danger-text">${r.danger_signs.map((d) => esc(DANGER_SIGN[d] ?? d)).join(', ')}</span>` : 'none recorded'],
    ['Body temperature', fmtTemp(r?.body_temp_c)],
  ];
  if (s.firmware_version === 'simulated') det.unshift(['Data', '<span class="tag demo">demo</span> simulated device: not a real screening']);
  if (r?.rules_version) det.push(['Rules', esc(r.rules_version)]);
  $('#session-details').innerHTML = det.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');

  const byStep = new Map();
  for (const a of attempts) (byStep.get(a.step_id) ?? byStep.set(a.step_id, []).get(a.step_id)).push(a);
  const sorted = [...st].sort((x, y) => STEP_ORDER.indexOf(x.type) - STEP_ORDER.indexOf(y.type));
  const rows = [];
  for (const step of sorted) {
    const list = byStep.get(step.id) ?? [];
    const head = [`<b>${esc(STEP_LABEL[step.type] || step.type)}</b>`, step.required ? 'yes' : '<span class="muted">optional</span>', stepStatus(step.status)];
    if (!list.length) { rows.push([...head, '<span class="muted">not recorded</span>', '', '', '', '', '']); continue; }
    list.forEach((a, i) => {
      const accepted = step.accepted_attempt ? a.id === step.accepted_attempt : i === list.length - 1;
      rows.push([...(i ? ['', '', ''] : head), `#${esc(a.n)}`, fmtValues(a.values),
        a.quality === 'good' || !a.quality ? esc(a.quality || '—') : `<span class="warn">${esc(a.quality)}</span>`, fmtModel(a.model_output),
        a.recording_id ? `<button class="ghost play" data-rec="${esc(a.recording_id)}">▶ Play</button>` : '<span class="muted">—</span>',
        accepted ? '<span class="ok">✓ accepted</span>' : '<span class="muted">superseded</span>']);
    });
  }
  $('#session-steps').innerHTML = table(['Step', 'Required', 'Status', 'Attempt', 'Values', 'Quality', 'Model', 'Recording', ''], rows);
  $('#session-steps').querySelectorAll('button.play').forEach((btn) => btn.addEventListener('click', () => playRecording(btn)));
}

// The token goes in a header, never a URL, so fetch the WAV and play it from a blob.
async function playRecording(btn) {
  btn.disabled = true; btn.textContent = 'Loading…';
  try {
    const res = await fetch(`/api/recordings/${btn.dataset.rec}`, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401) return signOut();
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const url = URL.createObjectURL(await res.blob());
    audioUrls.push(url);
    const audio = document.createElement('audio');
    audio.controls = true; audio.src = url;
    btn.replaceWith(audio);
    audio.play().catch(() => {});
  } catch (err) { btn.disabled = false; btn.textContent = `Retry (${err.message})`; }
}
$('#session-back').addEventListener('click', () => (sessionCtx?.babyId ? loadBaby(sessionCtx.babyId) : backView === 'babies' ? loadBabies() : loadOverview()));
$('#session-live').addEventListener('click', () => openLive(sessionCtx.id));

// ── users (supervisors) ──
let users = [];
let editing = null;
async function loadUsers() {
  show('users');
  users = await api('/api/workers');
  $('#user-list').innerHTML = table(['Name', 'Username', 'Role', 'Status', 'Children', 'Screenings', 'Last sign-in'],
    users.map((u) => [`<b>${esc(u.name)}</b>${u.id === me.id ? ' <span class="muted">(you)</span>' : ''}`, esc(u.username),
      u.role === 'supervisor' ? 'Supervisor' : 'Health worker',
      u.active ? '<span class="ok">active</span>' : '<span class="muted">turned off</span>',
      esc(u.babies), esc(u.sessions), esc(u.last_login ? fmtDate(u.last_login) : 'never')]), true);
  bindRows($('#user-list'), users, editUser);
}
function editUser(u) {
  editing = u;
  const f = $('#user-edit-form');
  $('#user-edit').hidden = false;
  $('#user-edit-title').textContent = `Edit ${u.name}`;
  f.name.value = u.name; f.role.value = u.role; f.active.checked = u.active; f.password.value = '';
  $('#user-edit-error').textContent = '';
  f.name.focus();
}
$('#user-edit-cancel').addEventListener('click', () => { $('#user-edit').hidden = true; editing = null; });
$('#user-edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#user-edit-error').textContent = '';
  try {
    await api(`/api/workers/${editing.id}`, { method: 'PATCH', body: JSON.stringify({ name: f.name.value, role: f.role.value, active: f.active.checked }) });
    if (f.password.value) await api(`/api/workers/${editing.id}/password`, { method: 'POST', body: JSON.stringify({ password: f.password.value }) });
    $('#user-edit').hidden = true; editing = null;
    await loadUsers();
  } catch (err) { $('#user-edit-error').textContent = err.message; }
});
$('#user-add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#user-add-error').textContent = ''; $('#user-add-ok').textContent = '';
  try {
    const u = await api('/api/workers', { method: 'POST', body: JSON.stringify({ name: f.name.value, username: f.username.value, role: f.role.value, password: f.password.value }) });
    f.reset();
    $('#user-add-ok').textContent = `Added ${u.name}. They can sign in as “${u.username}”.`;
    await loadUsers();
  } catch (err) { $('#user-add-error').textContent = err.message; }
});

// ── live ──
function openLive(sessionId) {
  show('live');
  $('#live-log').innerHTML = '';
  $('#live-status').textContent = 'Connecting…';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  liveWs = new WebSocket(`${proto}://${location.host}/ws/session/${encodeURIComponent(sessionId)}`);
  liveWs.onopen = () => liveWs.send(JSON.stringify({ type: 'auth', token, role: 'watcher' }));
  liveWs.onclose = (e) => { $('#live-status').textContent = e.code === 4404 ? 'Session not found.' : 'Disconnected.'; };
  liveWs.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === 'presence') {
      $('#live-status').textContent = msg.publishers ? 'Phone connected: watching live.' : 'Waiting for the phone to join this screening…';
    } else if (msg.type === 'event') {
      const e = msg.event;
      if (e.kind === 'level') return;
      const li = document.createElement('li');
      const detail = { ...e }; delete detail.kind; delete detail.step;
      li.textContent = `${new Date(msg.at).toLocaleTimeString()}  ${e.kind}${e.step ? ` ${STEP_LABEL[e.step] || e.step}` : ''}  ${Object.keys(detail).length ? JSON.stringify(detail) : ''}`;
      $('#live-log').prepend(li);
    }
  };
}
$('#live-back').addEventListener('click', () => (sessionCtx ? openSession(sessionCtx.id, sessionCtx) : backView === 'babies' ? loadBabies() : loadOverview()));

// ── start ──
async function start() {
  if (!token) return show('login');
  try { me = await api('/api/me'); } catch { return; }
  $('#who').textContent = `${me.name} (${me.role})`;
  $('#nav').hidden = false;
  $('#nav-users').hidden = me.role !== 'supervisor';
  await loadOverview();
}
start();
