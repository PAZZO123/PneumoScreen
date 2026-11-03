// Record the PneumoScreen demo: scripted run of the app (simulated device) and the
// supervisor dashboard, captured with the Chrome DevTools screencast.
// Output: frames/*.jpg + frames.json (timestamps) + scenes.json + stills/*.png
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const DIR = new URL('.', import.meta.url).pathname;
const env = Object.fromEntries(readFileSync(`${DIR}db/.env.local`, 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => l.split('=')));
const narration = JSON.parse(readFileSync(`${DIR}narration.json`, 'utf8'));   // [{ id, text, seconds }]
const APP = 'http://localhost:5174', DASH = 'http://localhost:8788';

rmSync(`${DIR}frames`, { recursive: true, force: true }); mkdirSync(`${DIR}frames`); mkdirSync(`${DIR}stills`, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  args: ['--hide-scrollbars', '--force-color-profile=srgb', '--lang=en-GB'],
});
const page = await browser.newPage();
// A visible tap marker, since headless Chrome draws no cursor.
await page.evaluateOnNewDocument(() => {
  addEventListener('pointerdown', (e) => {
    const d = document.createElement('div');
    Object.assign(d.style, { position: 'fixed', left: `${e.clientX - 22}px`, top: `${e.clientY - 22}px`, width: '44px', height: '44px', borderRadius: '50%',
      background: 'rgba(20,184,166,.35)', border: '3px solid rgba(13,148,136,.9)', zIndex: 99999, pointerEvents: 'none', transition: 'transform .5s, opacity .5s' });
    document.documentElement.appendChild(d);
    requestAnimationFrame(() => { d.style.transform = 'scale(1.6)'; d.style.opacity = '0'; });
    setTimeout(() => d.remove(), 600);
  }, true);
});

const cdp = await page.createCDPSession();
const frames = [];
let t0 = 0;
cdp.on('Page.screencastFrame', async (f) => {
  const n = frames.length, file = `frames/${String(n).padStart(5, '0')}.jpg`;
  writeFileSync(`${DIR}${file}`, Buffer.from(f.data, 'base64'));
  frames.push({ file, t: f.metadata.timestamp });
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;
const scenes = [];
const N = Object.fromEntries(narration.map((n) => [n.id, n]));
/** Run one scene; it lasts at least as long as its narration (plus a breath). */
async function scene(id, fn) {
  const start = now();
  scenes.push({ id, start });
  await fn();
  const min = (N[id]?.seconds ?? 0) + 0.7;
  const left = start + min - now();
  if (left > 0) await sleep(left * 1000);
  scenes.at(-1).end = now();
  console.log(`scene ${id}: ${(scenes.at(-1).end - start).toFixed(1)} s`);
}
const byText = (t) => page.locator(`::-p-text(${t})`);
const click = async (t, pause = 700) => { await byText(t).setTimeout(20000).click(); await sleep(pause); };
const still = (name) => page.screenshot({ path: `${DIR}stills/${name}.png` });
const card = (title, sub) => page.setContent(`<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0f1e36;font-family:Arial,sans-serif;color:#fff">
  <div style="text-align:center"><div style="font-size:30px;color:#5eead4;margin-bottom:18px">🫁</div>
  <div style="font-size:64px;font-weight:700;letter-spacing:.5px">${title}</div>
  <div style="font-size:28px;color:#cbd5e1;margin-top:16px">${sub}</div></div></body></html>`);

await card('PneumoScreen', 'Demo · simulated sensor data');
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
t0 = now();
await scene('intro', async () => {});

await scene('login', async () => {
  await page.goto(APP, { waitUntil: 'networkidle0' });
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('ps_demo', '1'); });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('input[name=username]', { timeout: 60000 });
  await sleep(400);
  await page.type('input[name=username]', 'chw1', { delay: 90 });
  await page.type('input[name=password]', env.CHW1_PASSWORD, { delay: 40 });
  await sleep(300);
  await click('Sign in', 1500);
});

await scene('connect', async () => {
  await click('Connect simulated gateway', 2200);
  await still('01-device');
});

await scene('patient', async () => {
  await click('Keza Iradukunda', 1800);
  await still('02-patient');
  await page.evaluate(() => window.scrollTo({ top: 260, behavior: 'smooth' }));
  await sleep(1800);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await sleep(600);
  await click('Start screening', 1200);
});

await scene('breath', async () => {
  await click('Record 30 s', 4200);
  await still('03-countdown');
  await byText('Record again').setTimeout(40000).wait();
  await sleep(1200);
  await still('04-breath');
});

await scene('temp', async () => {
  await page.click('input[placeholder="e.g. 37.2"]');
  await page.type('input[placeholder="e.g. 37.2"]', '38.4', { delay: 160 });
  await sleep(1200);
});

await scene('lungs', async () => {
  await click('Continue to lung sounds', 1500);
  await click('Record 10 s', 2000);
  await still('05-lung-recording');
  await byText('Record again').setTimeout(40000).wait();
  await sleep(800);
  await page.evaluate(() => window.scrollTo({ top: 300, behavior: 'smooth' }));
  await sleep(2200);
  await still('06-lung-result');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await sleep(600);
});

await scene('triage', async () => {
  await click('See the result', 2200);
  await still('07-triage');
  await page.evaluate(() => window.scrollTo({ top: 700, behavior: 'smooth' }));
  await sleep(1500);
  await click('Finish and save', 1800);
});

await scene('dashboard', async () => {
  await page.goto(DASH, { waitUntil: 'networkidle0' });
  await page.waitForSelector('input[name=username]', { visible: true, timeout: 30000 });
  await page.type('input[name=username]', 'supervisor', { delay: 70 });
  await page.type('input[name=password]', env.SUPERVISOR_PASSWORD, { delay: 30 });
  await page.keyboard.press('Enter');
  await sleep(2200);
  await still('08-dashboard');
  await page.evaluate(() => window.scrollTo({ top: 360, behavior: 'smooth' }));
  await sleep(2000);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await sleep(800);
});

await scene('outro', async () => { await card('PneumoScreen', 'Early warning. Timely referral.'); });

await sleep(500);
await cdp.send('Page.stopScreencast');
await sleep(300);
writeFileSync(`${DIR}frames.json`, JSON.stringify({ t0, frames }));
writeFileSync(`${DIR}scenes.json`, JSON.stringify(scenes.map((s) => ({ ...s, start: s.start - t0, end: s.end - t0 }))));
await browser.close();
console.log(`${frames.length} frames, ${(now() - t0).toFixed(1)} s`);
