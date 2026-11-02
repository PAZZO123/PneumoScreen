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
  for (const id of ['login', 'overview', 'babies', 'baby', 'live']) $(`#${id}`).hidden = id !== view;
  if (view !== 'live' && liveWs) { liveWs.close(); liveWs = null; }
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
const referTag = (r) => (r == null ? '<span class="muted">—</span>' : r ? '<span class="tag refer">Refer</span>' : '<span class="tag ok">No refer</span>');
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
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => (b.dataset.view === 'overview' ? loadOverview() : loadBabies())));

// ── overview ──
async function loadOverview() {
  show('overview');
  backView = 'overview';
  const qs = new URLSearchParams();
  if ($('#from').value) qs.set('from', $('#from').value);
  if ($('#to').value) qs.set('to', new Date(new Date($('#to').value).getTime() + 86400000).toISOString().slice(0, 10));
  const o = await api(`/api/analytics/overview?${qs}`);
  const t = o.totals;
  const stats = [
    ['Babies', t.babies], ['Screened', t.babies_screened], ['Screenings', t.sessions], ['Complete', t.complete],
    ['Incomplete', t.incomplete], ['Referred', t.referred], ['Refer rate', t.refer_rate == null ? '—' : `${Math.round(t.refer_rate * 100)}%`],
  ];
  $('#totals').innerHTML = stats.map(([k, v]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');
  $('#follow-up').innerHTML = table(['Baby', 'Started', 'Worker', 'Missing steps'],
    o.follow_up.map((r) => [esc(r.baby_name), esc(fmtDate(r.started_at)), esc(r.worker), `<span class="warn">${steps(r.missing) || 'steps not started'}</span>`]), true);
  bindRows($('#follow-up'), o.follow_up, (r) => openLive(r.session_id));
  $('#per-day').innerHTML = table(['Day', 'Screenings', 'Referred'], o.per_day.map((r) => [esc(r.day), esc(r.sessions), esc(r.referred ?? 0)]));
  $('#per-worker').innerHTML = table(['Worker', 'Screenings', 'Complete', 'Referred'], o.per_worker.map((r) => [esc(r.worker), esc(r.sessions), esc(r.complete), esc(r.referred ?? 0)]));
  $('#devices').innerHTML = table(['Device', 'Firmware', 'Last seen', 'Last worker'], o.devices.map((d) => [esc(d.device_id), esc(d.firmware_version), esc(fmtDate(d.last_seen)), esc(d.last_worker)]));
}
$('#refresh').addEventListener('click', loadOverview);

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
  $('#trend-temp').innerHTML = sparkline(a.trends.temp_c, '°');
  const lungCell = (c) => (c == null ? '<span class="muted">—</span>' : c === 'normal' ? esc(c) : `<span class="${c === 'noise' ? 'warn' : 'refer'}">${esc(c)}</span>`);
  const visits = [...a.visits].reverse();
  $('#visits').innerHTML = table(['Date', 'Worker', 'Result', 'Breath', 'R-up', 'L-up', 'R-low', 'L-low', 'SpO₂', 'Status'],
    visits.map((v) => [esc(fmtDate(v.started_at)), esc(v.worker), referTag(v.refer), esc(v.breath_bpm ?? '—'),
      lungCell(v.lung.RU), lungCell(v.lung.LU), lungCell(v.lung.RL), lungCell(v.lung.LL), esc(v.spo2 ?? '—'),
      v.status === 'complete' ? '<span class="ok">complete</span>' : `<span class="warn">missing: ${steps(v.missing)}</span>`]), true);
  bindRows($('#visits'), visits, (v) => openLive(v.session_id));
}

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
$('#live-back').addEventListener('click', () => (backView === 'babies' ? loadBabies() : loadOverview()));

// ── start ──
async function start() {
  if (!token) return show('login');
  try { me = await api('/api/me'); } catch { return; }
  $('#who').textContent = `${me.name} (${me.role})`;
  $('#nav').hidden = false;
  await loadOverview();
}
start();
