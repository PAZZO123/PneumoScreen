// PneumoScreen deck v2, built to docs/presentation/DECK_PLAN.md with the pptx-design rules:
// point form, ≤ 5 points, one message and one visual per slide, Arial, sentence case,
// 36 pt titles / 24 pt points / 18–20 pt secondary / 14 pt captions, navy + teal, triage colours only for meaning.
const fs = require('fs');
const path = require('path');
const pptxgen = require('pptxgenjs');
const sharp = require('sharp');
const { applyTheme } = require(process.env.PPTX_SKILL + '/scripts/apply_theme.js');

const ROOT = '/Users/c/Downloads/Project/PneumoScreen/docs/presentation';
const IMG = (f) => path.join(ROOT, 'images', f);
const OUT = process.argv[2] || path.join(__dirname, 'PneumoScreen-v4.pptx');
const VIDEO = process.env.DEMO_VIDEO || path.join(ROOT, 'PneumoScreen-demo.mp4');
const POSTER = process.env.DEMO_POSTER || IMG('poster.png');

const THEME = {
  name: 'PneumoScreen',
  headFontFace: 'Arial', bodyFontFace: 'Arial',
  colors: {
    dk1: '0F172A', lt1: 'FFFFFF', dk2: '0F1E36', lt2: 'F1F5F9',
    accent1: '0F766E', accent2: '14B8A6', accent3: 'DC2626', accent4: 'D97706', accent5: '059669', accent6: '64748B',
    hlink: '0F766E', folHlink: '115E59',
  },
};
const H = THEME.colors;   // hex, for the options that take hex only
const W = 13.333, M = 0.6;

const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
pres.title = 'PneumoScreen';
pres.author = 'PneumoScreen team';
pres.subject = 'Low-cost pneumonia screening aid for children under five';
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
const C = pres.SchemeColor;

// ── icons: Lucide SVG → PNG, drawn in the given colour ──
const ICON_DIR = path.join(__dirname, 'node_modules/lucide-static/icons');
const iconCache = {};
async function icon(name, color = 'FFFFFF') {
  const key = name + color;
  if (!iconCache[key]) {
    const svg = fs.readFileSync(path.join(ICON_DIR, name + '.svg'), 'utf8').replace(/currentColor/g, '#' + color);
    const png = await sharp(Buffer.from(svg), { density: 600 }).resize(256, 256).png().toBuffer();
    iconCache[key] = 'image/png;base64,' + png.toString('base64');
  }
  return iconCache[key];
}
/** The deck's motif: a white icon in a teal circle. */
async function badge(slide, name, x, y, d = 0.8, fill = C.accent1, objectName = 'icon') {
  slide.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: fill }, line: { type: 'none' }, objectName: objectName + ' circle' });
  const p = d * 0.25;
  slide.addImage({ data: await icon(name), x: x + p, y: y + p, w: d - 2 * p, h: d - 2 * p, altText: name.replace(/-/g, ' '), objectName });
}

// ── layouts ──
pres.defineSlideMaster({
  title: 'PS_DARK',
  background: { color: C.text2 },
  objects: [{ text: { text: 'PneumoScreen  ·  early warning, timely referral', options: { x: M, y: 6.95, w: 8, h: 0.35, fontSize: 12, color: 'A7F3D0', margin: 0 } } }],
  slideNumber: { x: W - M - 0.6, y: 6.95, w: 0.6, h: 0.35, fontSize: 12, color: 'CBD5E1', align: 'right' },
});
pres.defineSlideMaster({
  title: 'PS_CONTENT',
  background: { color: C.background1 },
  objects: [
    { placeholder: { options: { name: 'title', type: 'title', x: M, y: 0.62, w: W - 2 * M, h: 0.85, fontSize: 36, bold: true, color: C.text2, valign: 'middle', margin: 0 }, text: '' } },
    { text: { text: 'PneumoScreen  ·  early warning, timely referral', options: { x: M, y: 6.95, w: 8, h: 0.35, fontSize: 12, color: '64748B', margin: 0 } } },
  ],
  slideNumber: { x: W - M - 0.6, y: 6.95, w: 0.6, h: 0.35, fontSize: 12, color: '64748B', align: 'right' },
});

const SECTION_NO = { Problem: 1, Solution: 2, Technology: 3, Demo: 4, Conclusion: 5 };
/** Content slide: a small section label (where we are in the talk) above the title. */
const content = (section, title) => {
  const s = pres.addSlide({ masterName: 'PS_CONTENT', sectionTitle: section });
  if (SECTION_NO[section]) s.addText(`${SECTION_NO[section]} · ${section}`, { isTextBox: true, x: M, y: 0.28, w: 6, h: 0.35, margin: 0, fontSize: 16, bold: true, color: C.accent1 });
  s.addText(title, { placeholder: 'title' });
  return s;
};
const dark = (section) => pres.addSlide({ masterName: 'PS_DARK', sectionTitle: section });
const txt = (slide, text, o) => slide.addText(text, { isTextBox: true, margin: 0, fontFace: 'Arial', valign: 'top', ...o });
const source = (slide, text) => txt(slide, text, { x: M, y: 6.5, w: W - 2 * M, h: 0.35, fontSize: 14, color: C.accent6 });
const card = (slide, x, y, w, h, fill = C.background2, name = 'card') =>
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.12, fill: { color: fill }, line: { type: 'none' }, objectName: name });
const picture = (slide, file, x, y, w, h, alt) => {
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: x - 0.05, y: y - 0.05, w: w + 0.1, h: h + 0.1, rectRadius: 0.08, fill: { color: 'E2E8F0' }, line: { type: 'none' },
    shadow: { type: 'outer', color: '0F172A', opacity: 0.18, blur: 8, offset: 3, angle: 90 }, objectName: alt + ' frame' });
  slide.addImage({ path: file, x, y, w, h, altText: alt, objectName: alt });
};

(async () => {
  // Seven slides, few words: the presenters explain (speaker notes carry the script).

  // 1 ── title + hook
  pres.addSection({ title: 'Opening' });
  {
    const s = dark('Opening');
    txt(s, '2,000 children.\nEvery day.', { x: M, y: 0.9, w: 7.6, h: 2.3, fontSize: 60, bold: true, color: C.background1, lineSpacingMultiple: 0.95 });
    txt(s, 'Under-five deaths from pneumonia, each day [1]', { x: M, y: 3.3, w: 7.4, h: 0.5, fontSize: 22, color: 'CBD5E1' });
    txt(s, 'PneumoScreen', { x: M, y: 4.55, w: 7.4, h: 0.9, fontSize: 44, bold: true, color: '5EEAD4' });
    txt(s, 'Early warning. Timely referral.', { x: M, y: 5.45, w: 7.4, h: 0.5, fontSize: 24, italic: true, color: C.background1 });
    s.addShape(pres.shapes.OVAL, { x: 8.9, y: 1.3, w: 3.9, h: 3.9, fill: { color: '134E4A' }, line: { type: 'none' }, objectName: 'motif ring' });
    s.addShape(pres.shapes.OVAL, { x: 9.55, y: 1.95, w: 2.6, h: 2.6, fill: { color: C.accent2 }, line: { type: 'none' }, objectName: 'motif core' });
    s.addImage({ data: await icon('stethoscope'), x: 10.25, y: 2.65, w: 1.2, h: 1.2, altText: 'stethoscope', objectName: 'motif icon' });
    s.addNotes('About 2,000 children under five die of pneumonia every day (UNICEF). PneumoScreen is a low-cost screening aid that helps community health workers recognise the warning signs early and refer in time. It is a working prototype: a sensor device, a phone app and a clinic dashboard.');
  }

  // 2 ── problem
  pres.addSection({ title: 'Problem' });
  {
    const s = content('Problem', 'A preventable killer of children');
    const stats = [['2,000', 'deaths a day [1]'], ['700,000+', 'deaths a year [1]'], ['13%', 'of under-five deaths [2]']];
    const w = (W - 2 * M - 2 * 0.4) / 3;
    for (let i = 0; i < 3; i++) {
      const x = M + i * (w + 0.4);
      card(s, x, 1.75, w, 2.4, C.background2, 'stat ' + (i + 1));
      txt(s, stats[i][0], { x: x + 0.35, y: 2.0, w: w - 0.7, h: 1.1, fontSize: 48, bold: true, color: C.accent1 });
      txt(s, stats[i][1], { x: x + 0.35, y: 3.2, w: w - 0.7, h: 0.6, fontSize: 22, color: C.text1 });
    }
    txt(s, 'The gap', { x: M, y: 4.55, w: 3, h: 0.45, fontSize: 20, bold: true, color: C.accent6 });
    const steps = [['eye', 'Recognise'], ['clipboard-check', 'Assess'], ['send', 'Refer']];
    const sw = (W - 2 * M) / 3;
    for (let i = 0; i < 3; i++) {
      const x = M + i * sw;
      await badge(s, steps[i][0], x, 5.15, 0.85, C.accent1, steps[i][1] + ' icon');
      txt(s, steps[i][1], { x: x + 1.05, y: 5.15, w: sw - 1.6, h: 0.85, fontSize: 26, bold: true, color: C.text2, valign: 'middle' });
      if (i < 2) s.addShape(pres.shapes.RIGHT_ARROW, { x: x + sw - 0.75, y: 5.4, w: 0.5, h: 0.36, fill: { color: C.accent2 }, line: { type: 'none' }, objectName: 'arrow ' + (i + 1) });
    }
    source(s, '[1] UNICEF   [2] UN IGME 2025');
    s.addNotes('Three numbers: about 2,000 deaths a day, over 700,000 a year, and 13 percent of all under-five deaths in 2024. Nearly all are preventable with timely care. The gap is not only treatment: it is recognising the signs early, assessing the child, and referring in time — at community level, where health workers have few tools.');
  }

  // 3 ── solution
  pres.addSection({ title: 'Solution' });
  {
    const s = content('Solution', 'One screening, four signals');
    const items = [['audio-lines', 'Lung sounds', 'AI'], ['wind', 'Breathing rate', 'motion sensor'], ['heart-pulse', 'Oxygen', 'SpO₂'], ['thermometer', 'Temperature', 'thermometer']];
    const cw = (W - 2 * M - 3 * 0.35) / 4;
    for (let i = 0; i < 4; i++) {
      const x = M + i * (cw + 0.35);
      card(s, x, 1.75, cw, 2.75, C.background2, items[i][1] + ' card');
      await badge(s, items[i][0], x + (cw - 1.1) / 2, 2.05, 1.1, C.accent1, items[i][1] + ' icon');
      txt(s, items[i][1], { x: x + 0.15, y: 3.35, w: cw - 0.3, h: 0.5, fontSize: 24, bold: true, color: C.text2, align: 'center' });
      txt(s, items[i][2], { x: x + 0.15, y: 3.85, w: cw - 0.3, h: 0.45, fontSize: 18, color: C.accent6, align: 'center' });
    }
    const tiers = [['octagon-alert', 'Danger', C.accent3], ['triangle-alert', 'Refer', C.accent4], ['circle-check-big', 'Normal', C.accent5]];
    const tw = (W - 2 * M - 2 * 0.35) / 3;
    for (let i = 0; i < 3; i++) {
      const x = M + i * (tw + 0.35);
      card(s, x, 4.9, tw, 1.2, C.background2, tiers[i][1] + ' result');
      await badge(s, tiers[i][0], x + 0.3, 5.08, 0.85, tiers[i][2], tiers[i][1] + ' icon');
      txt(s, tiers[i][1], { x: x + 1.35, y: 5.08, w: tw - 1.6, h: 0.85, fontSize: 28, bold: true, color: tiers[i][2], valign: 'middle' });
    }
    s.addNotes('PneumoScreen combines four signals in one screening: lung sounds, checked by an AI model on the phone for crackles and wheezes; breathing rate, counted by a motion sensor on the belly; oxygen saturation; and body temperature from a thermometer. The app turns them into one clear result. Danger: refer now — a danger sign, oxygen below 90 percent, or fever with crackles. Refer: today — fast breathing, crackles or wheezes, or fever. Otherwise normal. It supports the health worker; it does not diagnose.');
  }

  // 4 ── workflow
  {
    const s = content('Solution', 'Four steps for the health worker');
    const steps = [['crop-02-patient.png', 'Patient'], ['crop-04-breath.png', 'Vitals'], ['crop-06-lung-result.png', 'Lungs'], ['crop-07-triage.png', 'Triage']];
    const pw = 2.85, gap = (W - 2 * M - 4 * pw) / 3, ph = pw * 720 / 868;
    for (let i = 0; i < 4; i++) {
      const x = M + i * (pw + gap);
      s.addShape(pres.shapes.OVAL, { x, y: 2.2, w: 0.65, h: 0.65, fill: { color: C.accent1 }, line: { type: 'none' }, objectName: 'step ' + (i + 1) });
      txt(s, String(i + 1), { x, y: 2.2, w: 0.65, h: 0.65, fontSize: 22, bold: true, color: C.background1, align: 'center', valign: 'middle' });
      txt(s, steps[i][1], { x: x + 0.8, y: 2.2, w: pw - 0.8, h: 0.65, fontSize: 26, bold: true, color: C.text2, valign: 'middle' });
      picture(s, IMG(steps[i][0]), x, 3.15, pw, ph, steps[i][1] + ' screen');
    }
    source(s, 'App screens in demo mode (simulated sensor data)');
    s.addNotes('The app walks the health worker through four steps. Patient: the age sets the WHO breathing threshold, and the worker checks the danger signs. Vitals: breathing rate for 30 seconds, oxygen, temperature. Lungs: four chest positions; the AI says what it heard and asks to record again if it is too noisy. Triage: one clear result, saved to the clinic server with every recording.');
  }

  // 5 ── technology
  pres.addSection({ title: 'Technology' });
  {
    const s = content('Technology', 'How it works');
    const boxes = [['cpu', 'Sensor device', 'Arduino Nano 33 BLE'], ['smartphone', 'Phone app', 'AI + WHO rules'], ['server', 'Clinic dashboard', 'Records, follow-up']];
    const bw = 3.35, gap = (W - 2 * M - 3 * bw) / 2;
    for (let i = 0; i < 3; i++) {
      const x = M + i * (bw + gap);
      card(s, x, 1.75, bw, 2.75, C.background2, boxes[i][1] + ' box');
      await badge(s, boxes[i][0], x + (bw - 1.1) / 2, 2.0, 1.1, C.accent1, boxes[i][1] + ' icon');
      txt(s, boxes[i][1], { x: x + 0.2, y: 3.25, w: bw - 0.4, h: 0.5, fontSize: 24, bold: true, color: C.text2, align: 'center' });
      txt(s, boxes[i][2], { x: x + 0.2, y: 3.78, w: bw - 0.4, h: 0.45, fontSize: 18, color: C.accent6, align: 'center' });
      if (i < 2) {
        const ax = x + bw + 0.15;
        s.addShape(pres.shapes.RIGHT_ARROW, { x: ax, y: 2.95, w: gap - 0.3, h: 0.5, fill: { color: C.accent2 }, line: { type: 'none' }, objectName: 'arrow ' + (i + 1) });
        txt(s, i === 0 ? 'Bluetooth' : 'Wi-Fi', { x: ax - 0.25, y: 2.4, w: gap + 0.2, h: 0.45, fontSize: 16, bold: true, color: C.accent1, align: 'center' });
      }
    }
    txt(s, 'WHO fast breathing, per minute [3]', { x: M, y: 4.85, w: 6, h: 0.45, fontSize: 20, bold: true, color: C.text2 });
    const th = [['60', 'under 2 months'], ['50', '2–12 months'], ['40', '1–5 years'], ['21', 'over 5 years']];
    const tw = (W - 2 * M - 3 * 0.35) / 4;
    for (let i = 0; i < 4; i++) {
      const x = M + i * (tw + 0.35);
      card(s, x, 5.4, tw, 0.95, C.background2, 'threshold ' + th[i][1]);
      txt(s, th[i][0], { x: x + 0.3, y: 5.47, w: 1.0, h: 0.8, fontSize: 32, bold: true, color: C.accent1, valign: 'middle' });
      txt(s, th[i][1], { x: x + 1.3, y: 5.47, w: tw - 1.45, h: 0.8, fontSize: 18, color: C.text1, valign: 'middle' });
    }
    s.addNotes('The device records one step at a time and sends it over Bluetooth in numbered, checked parts; the app asks again for anything missing, so a weak link never corrupts a recording. The phone runs the lung-sound AI and the WHO IMCI rules, and saves to the clinic server, where supervisors follow every screening. The app picks the fast-breathing threshold from the child\'s age: 60, 50, 40 or 21 breaths a minute.');
  }

  // 6 ── demo (the re-voiced video)
  pres.addSection({ title: 'Demo' });
  {
    const s = dark('Demo');
    txt(s, '4 · Demo', { x: M, y: 0.28, w: 6, h: 0.35, fontSize: 16, bold: true, color: '5EEAD4' });
    txt(s, 'See it in action', { x: M, y: 0.62, w: 8, h: 0.85, fontSize: 36, bold: true, color: C.background1, valign: 'middle' });
    const vw = 8.0, vh = vw * 9 / 16, vy = 1.65;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: M - 0.06, y: vy - 0.06, w: vw + 0.12, h: vh + 0.12, rectRadius: 0.08, fill: { color: '1E293B' }, line: { color: C.accent2, width: 1.5 }, objectName: 'video frame' });
    s.addMedia({ type: 'video', path: VIDEO, x: M, y: vy, w: vw, h: vh, cover: 'image/png;base64,' + fs.readFileSync(POSTER).toString('base64'), objectName: 'Demo video' });
    const rx = M + vw + 0.45, rw = W - M - rx, rh = rw * 9 / 16;
    picture(s, IMG('08-dashboard.png'), rx, vy, rw, rh, 'Supervisor dashboard');
    txt(s, 'Clinic dashboard', { x: rx, y: vy + rh + 0.1, w: rw, h: 0.35, fontSize: 14, color: 'CBD5E1' });
    const py = vy + rh + 0.65;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: rx, y: py, w: rw, h: rh, rectRadius: 0.08, fill: { color: '1E293B' }, line: { color: '94A3B8', width: 1.25, dashType: 'dash' }, objectName: 'Device photo placeholder' });
    s.addImage({ data: await icon('image', '94A3B8'), x: rx + rw / 2 - 0.3, y: py + 0.35, w: 0.6, h: 0.6, altText: 'picture placeholder', objectName: 'placeholder icon' });
    txt(s, 'Add a photo of the device here', { x: rx + 0.2, y: py + 1.05, w: rw - 0.4, h: 0.45, fontSize: 16, color: 'CBD5E1', align: 'center' });
    txt(s, 'The device', { x: rx, y: py + rh + 0.1, w: rw, h: 0.35, fontSize: 14, color: 'CBD5E1' });
    txt(s, 'Click to play · simulated sensor data', { x: M, y: vy + vh + 0.15, w: vw, h: 0.4, fontSize: 16, color: 'CBD5E1' });
    s.addNotes('Play the video (76 seconds, narrated, simulated sensor data so no real child appears): sign in, connect the device, choose the child, count the breaths, record a lung sound, get the triage result, and see it on the clinic dashboard. Replace the right-hand placeholder with a photo of the device.');
  }

  // 7 ── conclusion
  pres.addSection({ title: 'Conclusion' });
  {
    const s = dark('Conclusion');
    txt(s, '5 · Conclusion', { x: M, y: 0.28, w: 6, h: 0.35, fontSize: 16, bold: true, color: '5EEAD4' });
    txt(s, 'Next: a validated pilot', { x: M, y: 0.62, w: 11, h: 0.85, fontSize: 40, bold: true, color: C.background1, valign: 'middle' });
    const cols = [
      ['hammer', 'Built', ['Device', 'Phone app', 'Clinic dashboard']],
      ['flask-conical', 'Next', ['SpO₂ sensor', 'More child data', 'Clinical validation']],
      ['handshake', 'We need', ['Mentors', 'Clinical partners', 'Pilot funding']],
    ];
    const cw = (W - 2 * M - 2 * 0.45) / 3;
    for (let i = 0; i < 3; i++) {
      const x = M + i * (cw + 0.45);
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 1.8, w: cw, h: 3.65, rectRadius: 0.12, fill: { color: '1E293B' }, line: { type: 'none' }, objectName: cols[i][1] + ' card' });
      await badge(s, cols[i][0], x + 0.4, 2.1, 0.9, i === 0 ? C.accent5 : C.accent2, cols[i][1] + ' icon');
      txt(s, cols[i][1], { x: x + 1.5, y: 2.1, w: cw - 1.8, h: 0.9, fontSize: 28, bold: true, color: C.background1, valign: 'middle' });
      txt(s, cols[i][2].map((t, j) => ({ text: t, options: { bullet: true, breakLine: j < 2 } })), { x: x + 0.45, y: 3.3, w: cw - 0.8, h: 1.9, fontSize: 22, color: 'E2E8F0', paraSpaceAfter: 10 });
    }
    txt(s, 'Early warning. Timely referral. Better-informed care.', { x: M, y: 5.7, w: 11, h: 0.5, fontSize: 24, italic: true, color: '5EEAD4' });
    txt(s, '[1] UNICEF, Pneumonia in children   [2] UN IGME, Child mortality report 2025   [3] WHO, IMCI chart booklet   ·   Research prototype, not a diagnostic device',
      { x: M, y: 6.35, w: W - 2 * M, h: 0.4, fontSize: 12, color: '94A3B8' });
    s.addNotes('To close: we have built the device, the phone app and the clinic dashboard, and they work together end to end. Next: SpO2 on the device, more children\'s recordings to improve the AI, and clinical validation. We are asking for mentorship, clinical partners for safe validation, and pilot funding. PneumoScreen is a research prototype, not a validated diagnostic device. References: UNICEF, Pneumonia in children (data.unicef.org); UN IGME, Levels and trends in child mortality 2025; WHO, Integrated Management of Childhood Illness chart booklet.');
  }

  await pres.writeFile({ fileName: OUT });
  await applyTheme(OUT, THEME);
  console.log('wrote', OUT);
})().catch((e) => { console.error(e); process.exit(1); });
