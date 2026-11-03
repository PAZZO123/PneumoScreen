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
const OUT = process.argv[2] || path.join(__dirname, 'PneumoScreen-v3.pptx');
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

const SECTION_NO = { Problem: 1, Solution: 2, Technology: 3, Demo: 4, Testing: 5, Conclusion: 6 };
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
  pres.addSection({ title: 'Opening' });
  {
    const s = dark('Opening');
    txt(s, 'A question to start', { x: M, y: 0.8, w: 7, h: 0.4, fontSize: 20, color: '5EEAD4', bold: true });
    txt(s, '2,000 children.\nEvery day.', { x: M, y: 1.4, w: 7.4, h: 2.4, fontSize: 60, bold: true, color: C.background1, lineSpacingMultiple: 0.95 });
    txt(s, 'Children under five who die of pneumonia, each day [1]', { x: M, y: 3.95, w: 7.2, h: 0.5, fontSize: 24, color: 'CBD5E1' });
    txt(s, 'What if every community health worker could spot the warning signs sooner?', { x: M, y: 5.15, w: 7.0, h: 1.0, fontSize: 24, italic: true, color: C.background1 });
    s.addShape(pres.shapes.OVAL, { x: 8.9, y: 1.3, w: 3.9, h: 3.9, fill: { color: '134E4A' }, line: { type: 'none' }, objectName: 'motif ring' });
    s.addShape(pres.shapes.OVAL, { x: 9.55, y: 1.95, w: 2.6, h: 2.6, fill: { color: C.accent2 }, line: { type: 'none' }, objectName: 'motif core' });
    s.addImage({ data: await icon('stethoscope'), x: 10.25, y: 2.65, w: 1.2, h: 1.2, altText: 'stethoscope', objectName: 'motif icon' });
    s.addNotes('Open with the number. About 2,000 children under five die of pneumonia every day, according to UNICEF. Pause, then ask the question: what if the health worker in the village could recognise the warning signs sooner?');
  }
  {
    const s = dark('Opening');
    txt(s, 'PneumoScreen', { x: M, y: 1.3, w: 6.6, h: 1.0, fontSize: 54, bold: true, color: C.background1 });
    txt(s, 'A low-cost screening aid for pneumonia in children under five', { x: M, y: 2.5, w: 6.4, h: 1.0, fontSize: 24, color: 'CBD5E1' });
    txt(s, [
      { text: 'Working prototype', options: { bold: true, color: '5EEAD4', breakLine: true } },
      { text: 'Sensor device  ·  phone app  ·  clinic dashboard', options: { color: C.background1 } },
    ], { x: M, y: 3.9, w: 6.4, h: 0.9, fontSize: 20 });
    txt(s, 'Project presentation  ·  November 2026', { x: M, y: 5.6, w: 6.4, h: 0.4, fontSize: 18, color: '94A3B8' });
    picture(s, IMG('crop-07-triage.png'), 7.6, 1.0, 5.1, 5.1 * 720 / 868, 'App triage screen');
    s.addNotes('PneumoScreen is a working prototype: a sensor device, a phone app for the health worker, and a dashboard for the clinic. The picture is the app\'s triage screen.');
  }
  {
    const s = dark('Opening');
    txt(s, 'Today', { x: M, y: 0.7, w: 6, h: 0.8, fontSize: 40, bold: true, color: C.background1 });
    const items = [['triangle-alert', 'Problem'], ['sparkles', 'Solution'], ['cpu', 'Technology'], ['play', 'Demo'], ['flask-conical', 'Testing'], ['flag', 'Conclusion']];
    const cw = (W - 2 * M - 2 * 0.4) / 3, ch = 1.9;
    for (let i = 0; i < items.length; i++) {
      const x = M + (i % 3) * (cw + 0.4), y = 1.9 + Math.floor(i / 3) * (ch + 0.35);
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: cw, h: ch, rectRadius: 0.12, fill: { color: '1E293B' }, line: { type: 'none' }, objectName: items[i][1] + ' card' });
      await badge(s, items[i][0], x + 0.35, y + 0.55, 0.8, C.accent2, items[i][1] + ' icon');
      txt(s, `${i + 1}`, { x: x + 1.35, y: y + 0.4, w: 1, h: 0.45, fontSize: 18, bold: true, color: '5EEAD4' });
      txt(s, items[i][1], { x: x + 1.35, y: y + 0.85, w: cw - 1.5, h: 0.6, fontSize: 26, bold: true, color: C.background1 });
    }
    s.addNotes('Six parts: the problem, our solution, the technology behind it, a short demo, how we tested it, and what comes next.');
  }
  pres.addSection({ title: 'Problem' });
  {
    const s = content('Problem', 'The gap is recognition and referral');
    card(s, M, 1.6, 5.2, 4.6, C.background2, 'stat card');
    txt(s, '700,000+', { x: M + 0.4, y: 2.1, w: 4.6, h: 1.2, fontSize: 66, bold: true, color: C.accent1 });
    txt(s, 'children under five die of pneumonia each year [1]', { x: M + 0.4, y: 3.4, w: 4.4, h: 1.0, fontSize: 24, color: C.text1 });
    txt(s, 'Nearly all preventable with timely care [1]', { x: M + 0.4, y: 4.8, w: 4.4, h: 0.9, fontSize: 20, color: C.accent6 });
    const rows = [['eye', 'Recognise', 'Notice warning signs early'], ['clipboard-check', 'Assess', 'Count breaths, listen, measure'], ['send', 'Refer', 'Decide quickly and clearly']];
    for (let i = 0; i < rows.length; i++) {
      const y = 1.75 + i * 1.5;
      await badge(s, rows[i][0], 6.5, y, 0.9, C.accent1, rows[i][1] + ' icon');
      txt(s, rows[i][1], { x: 7.65, y: y - 0.02, w: 5, h: 0.5, fontSize: 24, bold: true, color: C.text2 });
      txt(s, rows[i][2], { x: 7.65, y: y + 0.48, w: 5, h: 0.5, fontSize: 20, color: C.text1 });
    }
    source(s, '[1] UNICEF, Pneumonia in children');
    s.addNotes('The challenge is not only treatment. It is recognising the signs early, assessing the child, and referring in time. That is where a community health worker needs support.');
  }
  {
    const s = content('Problem', 'A large, preventable burden');
    const stats = [['2,000', 'deaths a day', 'children under five [1]'], ['700,000+', 'deaths a year', 'children under five [1]'], ['13%', 'of under-five deaths', 'lower respiratory infections, 2024 [2]']];
    const w = (W - 2 * M - 2 * 0.4) / 3;
    for (let i = 0; i < 3; i++) {
      const x = M + i * (w + 0.4);
      card(s, x, 1.7, w, 3.5, C.background2, 'stat ' + (i + 1));
      txt(s, stats[i][0], { x: x + 0.35, y: 2.0, w: w - 0.7, h: 1.1, fontSize: 50, bold: true, color: C.accent1 });
      txt(s, stats[i][1], { x: x + 0.35, y: 3.2, w: w - 0.7, h: 0.85, fontSize: 24, bold: true, color: C.text2 });
      txt(s, stats[i][2], { x: x + 0.35, y: 4.15, w: w - 0.7, h: 0.9, fontSize: 18, color: C.accent6 });
    }
    await badge(s, 'hospital', M, 5.55, 0.7, C.accent1, 'clinic icon');
    txt(s, 'The opportunity: support frontline workers, without replacing clinical diagnosis', { x: M + 0.95, y: 5.6, w: 11, h: 0.6, fontSize: 22, color: C.text1, valign: 'middle' });
    source(s, '[1] UNICEF, Pneumonia in children   [2] UN IGME, Levels and trends in child mortality 2025');
    s.addNotes('Three numbers: about 2,000 a day, over 700,000 a year, and 13 percent of all under-five deaths in 2024. Most are preventable. Our aim is to support the health worker, not to replace diagnosis.');
  }
  pres.addSection({ title: 'Solution' });
  {
    const s = content('Solution', 'Four signals in one screening');
    const items = [
      ['audio-lines', 'Lung sounds', 'AI flags crackles and wheezes'],
      ['wind', 'Breathing rate', 'Motion sensor on the belly'],
      ['heart-pulse', 'Oxygen (SpO₂)', 'Pulse oximeter: in progress'],
      ['thermometer', 'Temperature', 'Thermometer; fever flag'],
    ];
    const cw = (W - 2 * M - 0.4) / 2, ch = 2.05;
    for (let i = 0; i < 4; i++) {
      const x = M + (i % 2) * (cw + 0.4), y = 1.6 + Math.floor(i / 2) * (ch + 0.35);
      card(s, x, y, cw, ch, C.background2, items[i][1] + ' card');
      await badge(s, items[i][0], x + 0.4, y + 0.45, 1.1, C.accent1, items[i][1] + ' icon');
      txt(s, items[i][1], { x: x + 1.8, y: y + 0.45, w: cw - 2.1, h: 0.55, fontSize: 26, bold: true, color: C.text2 });
      txt(s, items[i][2], { x: x + 1.8, y: y + 1.05, w: cw - 2.1, h: 0.8, fontSize: 20, color: C.text1 });
    }
    txt(s, 'Assists recognition and referral; it does not diagnose', { x: M, y: 6.4, w: W - 2 * M, h: 0.4, fontSize: 18, italic: true, color: C.accent6 });
    s.addNotes('PneumoScreen combines four signals. Lung sounds with an AI model, breathing rate from a motion sensor, oxygen saturation, which is still in progress on the device, and the child\'s temperature from a thermometer. It supports the decision; it does not diagnose.');
  }
  {
    const s = content('Solution', 'Four steps for the health worker');
    const steps = [['crop-02-patient.png', 'Patient', 'Age band, danger signs'], ['crop-04-breath.png', 'Vitals', 'Breath rate, SpO₂, fever'], ['crop-06-lung-result.png', 'Lungs', '4 positions, AI result'], ['crop-07-triage.png', 'Triage', 'Normal, refer or danger']];
    const pw = 2.85, gap = (W - 2 * M - 4 * pw) / 3, ph = pw * 720 / 868;
    for (let i = 0; i < 4; i++) {
      const x = M + i * (pw + gap);
      s.addShape(pres.shapes.OVAL, { x, y: 1.6, w: 0.6, h: 0.6, fill: { color: C.accent1 }, line: { type: 'none' }, objectName: 'step ' + (i + 1) });
      txt(s, String(i + 1), { x, y: 1.6, w: 0.6, h: 0.6, fontSize: 20, bold: true, color: C.background1, align: 'center', valign: 'middle' });
      txt(s, steps[i][1], { x: x + 0.75, y: 1.6, w: pw - 0.75, h: 0.6, fontSize: 24, bold: true, color: C.text2, valign: 'middle' });
      picture(s, IMG(steps[i][0]), x, 2.45, pw, ph, steps[i][1] + ' screen');
      txt(s, steps[i][2], { x, y: 2.6 + ph, w: pw, h: 0.5, fontSize: 18, color: C.text1 });
    }
    source(s, 'Screens from the app in demo mode (simulated sensor data)');
    s.addNotes('The app walks the health worker through four steps. Patient: the age band and the danger signs. Vitals: breathing rate, oxygen and temperature. Lungs: four chest positions, each with an AI result. And triage.');
  }
  {
    const s = content('Solution', 'One clear result: normal, refer or danger');
    const tiers = [
      ['octagon-alert', 'Danger: refer now', 'Danger sign · SpO₂ below 90% · fever with crackles', C.accent3],
      ['triangle-alert', 'Refer: today', 'Fast breathing · crackles or wheezes · fever 38 °C+', C.accent4],
      ['circle-check-big', 'Normal', 'None of these · follow local guidance', C.accent5],
    ];
    for (let i = 0; i < 3; i++) {
      const y = 1.6 + i * 1.6;
      card(s, M, y, 7.4, 1.35, C.background2, tiers[i][1] + ' card');
      await badge(s, tiers[i][0], M + 0.3, y + 0.25, 0.85, tiers[i][3], tiers[i][1] + ' icon');
      txt(s, tiers[i][1], { x: M + 1.4, y: y + 0.18, w: 5.8, h: 0.5, fontSize: 24, bold: true, color: tiers[i][3] });
      txt(s, tiers[i][2], { x: M + 1.4, y: y + 0.7, w: 5.8, h: 0.5, fontSize: 18, color: C.text1 });
    }
    picture(s, IMG('crop-07-triage.png'), 8.55, 1.6, 4.15, 4.15 * 720 / 868, 'Triage result screen');
    txt(s, 'IMCI danger signs + referral rules [3]; tested in code', { x: 8.55, y: 5.25, w: 4.15, h: 0.8, fontSize: 16, color: C.accent6 });
    s.addNotes('Everything is combined into one of three results. Danger means refer now: any IMCI danger sign, oxygen below 90 percent, or fever with crackles. Refer means today: fast breathing, crackles or wheezes, or fever. Otherwise normal. The rules are written once, shared by the app, and covered by automated tests.');
  }
  pres.addSection({ title: 'Technology' });
  {
    const s = content('Technology', 'How it works');
    const boxes = [
      ['cpu', 'Sensor device', ['Arduino Nano 33 BLE Sense', 'Microphone, motion, temperature', 'Records each step']],
      ['smartphone', 'Phone app', ['Guides the health worker', 'Lung-sound AI on the phone', 'WHO IMCI triage rules']],
      ['server', 'Clinic server', ['Every screening and recording', 'Supervisor dashboard', 'Follow-up of missing steps']],
    ];
    const bw = 3.35, gap = (W - 2 * M - 3 * bw) / 2;
    for (let i = 0; i < 3; i++) {
      const x = M + i * (bw + gap);
      card(s, x, 1.65, bw, 4.4, C.background2, boxes[i][1] + ' box');
      await badge(s, boxes[i][0], x + (bw - 1.1) / 2, 1.95, 1.1, C.accent1, boxes[i][1] + ' icon');
      txt(s, boxes[i][1], { x: x + 0.2, y: 3.25, w: bw - 0.4, h: 0.55, fontSize: 24, bold: true, color: C.text2, align: 'center' });
      txt(s, boxes[i][2].map((t, j) => ({ text: t, options: { bullet: true, breakLine: j < 2 } })), { x: x + 0.35, y: 3.95, w: bw - 0.6, h: 1.9, fontSize: 18, color: C.text1, paraSpaceAfter: 6 });
      if (i < 2) {
        const ax = x + bw + 0.15;
        s.addShape(pres.shapes.RIGHT_ARROW, { x: ax, y: 3.25, w: gap - 0.3, h: 0.5, fill: { color: C.accent2 }, line: { type: 'none' }, objectName: 'arrow ' + (i + 1) });
        txt(s, i === 0 ? 'Bluetooth' : 'Wi-Fi', { x: ax - 0.25, y: 2.65, w: gap + 0.2, h: 0.45, fontSize: 16, bold: true, color: C.accent1, align: 'center' });
      }
    }
    txt(s, 'Each step: record → send in numbered parts → check (CRC) → ask again for anything missing', { x: M, y: 6.3, w: W - 2 * M, h: 0.45, fontSize: 18, color: C.accent6 });
    s.addNotes('The device records one step at a time and sends it over Bluetooth in numbered, checksummed parts; the app asks again for anything that went missing, so a weak link never corrupts a recording. The app runs the AI and the WHO rules, and the clinic server keeps every record for the supervisor.');
  }
  {
    const s = content('Technology', 'Breathing thresholds depend on age');
    txt(s, 'Figure 1: Fast-breathing thresholds by age (WHO IMCI)', { x: M, y: 1.65, w: 7.6, h: 0.45, fontSize: 18, bold: true, color: C.text2 });
    s.addChart(pres.charts.BAR, [{ name: 'Fast breathing from', labels: ['Under 2 months', '2–12 months', '1–5 years', 'Over 5 years'], values: [60, 50, 40, 21] }], {
      x: M, y: 2.15, w: 7.6, h: 4.2, barDir: 'col', chartColors: [H.accent1], showValue: true, dataLabelPosition: 'outEnd', dataLabelFontSize: 16, dataLabelColor: H.dk2,
      dataLabelFontFace: '+mn-lt', catAxisLabelFontFace: '+mn-lt', valAxisLabelFontFace: '+mn-lt', catAxisLabelFontSize: 14, valAxisLabelFontSize: 14,
      catAxisLabelColor: '334155', valAxisLabelColor: '334155', valAxisMinVal: 0, valAxisMaxVal: 70, valAxisMajorUnit: 10,
      showValAxisTitle: true, valAxisTitle: 'Breaths per minute', valAxisTitleFontSize: 14, valAxisTitleColor: '334155', valAxisTitleFontFace: '+mn-lt',
      showCatAxisTitle: true, catAxisTitle: 'Age group', catAxisTitleFontSize: 14, catAxisTitleColor: '334155', catAxisTitleFontFace: '+mn-lt',
      valGridLine: { color: 'E2E8F0', size: 1 }, catGridLine: { style: 'none' }, showLegend: false, barGapWidthPct: 70,
    });
    card(s, 8.7, 1.75, W - M - 8.7, 4.55, C.background2, 'threshold note');
    await badge(s, 'baby', 9.05, 2.05, 0.9, C.accent1, 'age icon');
    txt(s, [
      { text: 'Set from the date of birth', options: { bold: true, fontSize: 22, color: C.text2, breakLine: true } },
      { text: ' ', options: { fontSize: 10, breakLine: true } },
      { text: 'At or above the line: fast breathing → refer', options: { fontSize: 20, color: C.text1, breakLine: true } },
      { text: ' ', options: { fontSize: 10, breakLine: true } },
      { text: 'Reference thresholds, not device results', options: { fontSize: 18, italic: true, color: C.accent6 } },
    ], { x: 9.05, y: 3.15, w: W - M - 9.4, h: 3.0 });
    source(s, 'Source: [3] WHO, Integrated Management of Childhood Illness chart booklet');
    s.addNotes('WHO IMCI uses a different fast-breathing threshold for each age. The app works out the age band from the date of birth and applies the right threshold automatically. These are the clinical reference values, not our test results.');
  }
  pres.addSection({ title: 'Demo' });
  {
    const s = dark('Demo');
    txt(s, '4 · Demo', { x: M, y: 0.28, w: 6, h: 0.35, fontSize: 16, bold: true, color: '5EEAD4' });
    txt(s, 'See it in action', { x: M, y: 0.62, w: 8, h: 0.85, fontSize: 36, bold: true, color: C.background1, valign: 'middle' });
    const vw = 8.0, vh = vw * 9 / 16;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: M - 0.06, y: 1.65 - 0.06, w: vw + 0.12, h: vh + 0.12, rectRadius: 0.08, fill: { color: '1E293B' }, line: { color: C.accent2, width: 1.5 }, objectName: 'video frame' });
    const cover = fs.readFileSync(POSTER).toString('base64');
    s.addMedia({ type: 'video', path: VIDEO, x: M, y: 1.65, w: vw, h: vh, cover: 'image/png;base64,' + cover, objectName: 'Demo video' });
    txt(s, 'Narrated demo, 76 s · simulated sensor data · click to play', { x: M, y: 1.65 + vh + 0.15, w: vw, h: 0.4, fontSize: 16, color: 'CBD5E1' });
    const rx = M + vw + 0.45, rw = W - M - rx, rh = rw * 9 / 16;
    picture(s, IMG('08-dashboard.png'), rx, 1.65, rw, rh, 'Supervisor dashboard');
    txt(s, 'Supervisor dashboard', { x: rx, y: 1.65 + rh + 0.1, w: rw, h: 0.35, fontSize: 14, color: 'CBD5E1' });
    const py = 1.65 + rh + 0.65;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: rx, y: py, w: rw, h: rh, rectRadius: 0.08, fill: { color: '1E293B' }, line: { color: '94A3B8', width: 1.25, dashType: 'dash' }, objectName: 'Device photo placeholder' });
    s.addImage({ data: await icon('image', '94A3B8'), x: rx + rw / 2 - 0.3, y: py + 0.35, w: 0.6, h: 0.6, altText: 'picture placeholder', objectName: 'placeholder icon' });
    txt(s, 'Add a photo of the device here', { x: rx + 0.2, y: py + 1.05, w: rw - 0.4, h: 0.45, fontSize: 16, color: 'CBD5E1', align: 'center' });
    txt(s, 'Device on the chest', { x: rx, y: py + rh + 0.1, w: rw, h: 0.35, fontSize: 14, color: 'CBD5E1' });
    s.addNotes('Play the video: 76 seconds, narrated, with simulated sensor data so no real child appears. It shows sign-in, connecting the device, choosing the child, the breathing count, a lung recording with the AI result, triage, and the supervisor dashboard. Replace the right-hand placeholder with a photo of the device on a manikin or a volunteer\'s chest.');
  }
  pres.addSection({ title: 'Testing' });
  {
    const s = content('Testing', 'How we tested it');
    card(s, M, 1.75, 3.6, 4.55, C.background2, 'tests stat');
    txt(s, '62', { x: M + 0.4, y: 2.05, w: 2.9, h: 1.3, fontSize: 80, bold: true, color: C.accent1 });
    txt(s, 'automated tests, all passing', { x: M + 0.4, y: 3.45, w: 2.9, h: 0.9, fontSize: 22, bold: true, color: C.text2 });
    txt(s, [{ text: 'Server: 25', options: { breakLine: true } }, { text: 'AI and signals: 20', options: { breakLine: true } }, { text: 'Bluetooth protocol: 17' }], { x: M + 0.4, y: 4.45, w: 2.9, h: 1.3, fontSize: 18, color: C.accent6 });
    const rows = [
      ['git-compare', 'Same answer as the device', 'Phone AI matches the firmware, bit for bit'],
      ['cpu', 'Real board, real recordings', 'Lung and breath steps arrive whole; CRC passes'],
      ['shield-check', 'Rules and records', 'Triage, sign-in, access and sync, every change'],
      ['smartphone', 'Full screening, end to end', 'App to clinic server in demo mode (the video)'],
    ];
    for (let i = 0; i < rows.length; i++) {
      const y = 1.75 + i * 1.18;
      await badge(s, rows[i][0], 4.75, y + 0.08, 0.8, C.accent1, rows[i][1] + ' icon');
      txt(s, rows[i][1], { x: 5.8, y, w: W - M - 5.8, h: 0.45, fontSize: 22, bold: true, color: C.text2 });
      txt(s, rows[i][2], { x: 5.8, y: y + 0.47, w: W - M - 5.8, h: 0.5, fontSize: 18, color: C.text1 });
    }
    s.addNotes('Testing at four levels. 62 automated tests run on every change: 25 on the server, 20 on the signal processing and AI, 17 on the Bluetooth protocol. The phone computes exactly the same features and model output as the device firmware, bit for bit. On the real board, the lung and breathing recordings arrived complete with the checksum passing. And the full screening runs end to end, as in the demo.');
  }
  {
    const s = content('Testing', 'Lung-sound AI: early results');
    txt(s, 'Figure 2: Recall in children with pneumonia, by sound', { x: M, y: 1.7, w: 7.4, h: 0.45, fontSize: 18, bold: true, color: C.text2 });
    s.addChart(pres.charts.BAR, [{ name: 'Recall', labels: ['Normal', 'Crackles', 'Wheezes'], values: [77, 72, 63] }], {
      x: M, y: 2.1, w: 7.4, h: 4.1, barDir: 'col', chartColors: [H.accent1], showValue: true, dataLabelPosition: 'outEnd', dataLabelFontSize: 16, dataLabelColor: H.dk2,
      dataLabelFormatCode: '0"%"', dataLabelFontFace: '+mn-lt', catAxisLabelFontFace: '+mn-lt', valAxisLabelFontFace: '+mn-lt', catAxisLabelFontSize: 14, valAxisLabelFontSize: 14,
      catAxisLabelColor: '334155', valAxisLabelColor: '334155', valAxisMinVal: 0, valAxisMaxVal: 100, valAxisMajorUnit: 20,
      showValAxisTitle: true, valAxisTitle: 'Recall (%)', valAxisTitleFontSize: 14, valAxisTitleColor: '334155', valAxisTitleFontFace: '+mn-lt',
      showCatAxisTitle: true, catAxisTitle: 'True lung sound', catAxisTitleFontSize: 14, catAxisTitleColor: '334155', catAxisTitleFontFace: '+mn-lt',
      valGridLine: { color: 'E2E8F0', size: 1 }, catGridLine: { style: 'none' }, showLegend: false, barGapWidthPct: 80,
    });
    const stats = [['0.57', 'overall accuracy, 4 sound classes'], ['8,096', 'test windows from 516 patients'], ['20.8 KB', 'model size: runs on a phone']];
    for (let i = 0; i < 3; i++) {
      const y = 1.6 + i * 1.32;
      card(s, 8.5, y, W - M - 8.5, 1.15, C.background2, 'model stat ' + (i + 1));
      txt(s, stats[i][0], { x: 8.8, y: y + 0.1, w: W - M - 9.1, h: 0.55, fontSize: 30, bold: true, color: C.accent1 });
      txt(s, stats[i][1], { x: 8.8, y: y + 0.68, w: W - M - 9.1, h: 0.4, fontSize: 16, color: C.text1 });
    }
    txt(s, 'Promising, not yet enough: needs more child data and clinical validation', { x: 8.5, y: 5.65, w: W - M - 8.5, h: 0.7, fontSize: 16, italic: true, color: C.accent6 });
    source(s, 'Source: models/training_report.md; SPRSound test patients [5]; patients never seen in training');
    s.addNotes('Early model results, from patients the model never saw in training. On children with pneumonia from the SPRSound dataset, it recognised normal sounds 77 percent of the time, crackles 72 percent and wheezes 63 percent. Overall accuracy across four classes is 0.57 on 8,096 test windows. That is promising for a 21 kilobyte model, but not good enough yet: we need more children\'s recordings and clinical validation.');
  }
  pres.addSection({ title: 'Conclusion' });
  {
    const s = content('Conclusion', 'What we have, and what comes next');
    const done = ['Bluetooth gateway: record, send, check, resend', 'Lung-sound AI on the phone (same model as the device)', 'Guided screening with three-level triage', 'Clinic server, dashboard and recordings', '62 automated tests passing'];
    const next = ['SpO₂ sensor on the device firmware', 'Lung model accuracy 0.57: more child data', 'Clinical validation with partners', 'Offline storage on the phone'];
    const colw = (W - 2 * M - 0.5) / 2;
    card(s, M, 1.6, colw, 4.7, C.background2, 'working card');
    await badge(s, 'circle-check-big', M + 0.35, 1.85, 0.75, C.accent5, 'working icon');
    txt(s, 'Working now', { x: M + 1.3, y: 1.9, w: colw - 1.6, h: 0.6, fontSize: 24, bold: true, color: C.text2, valign: 'middle' });
    txt(s, done.map((t, j) => ({ text: t, options: { bullet: true, breakLine: j < done.length - 1 } })), { x: M + 0.4, y: 2.8, w: colw - 0.7, h: 3.3, fontSize: 18, color: C.text1, paraSpaceAfter: 9 });
    const x2 = M + colw + 0.5;
    card(s, x2, 1.6, colw, 4.7, C.background2, 'next card');
    await badge(s, 'flask-conical', x2 + 0.35, 1.85, 0.75, C.accent1, 'next icon');
    txt(s, 'Next', { x: x2 + 1.3, y: 1.9, w: colw - 1.6, h: 0.6, fontSize: 24, bold: true, color: C.text2, valign: 'middle' });
    txt(s, next.map((t, j) => ({ text: t, options: { bullet: true, breakLine: j < next.length - 1 } })), { x: x2 + 0.4, y: 2.8, w: colw - 0.7, h: 3.3, fontSize: 18, color: C.text1, paraSpaceAfter: 9 });
    source(s, 'Model accuracy from models/training_report.md (held-out test set)');
    s.addNotes('Be honest about status. The gateway, the AI on the phone, the guided screening, triage and the dashboard all work, with 62 automated tests. Next: SpO2 on the device, a better lung model with more children\'s recordings (accuracy is 0.57 today), clinical validation, and offline storage.');
  }
  {
    const s = content('Conclusion', 'Roadmap to a responsible pilot');
    const steps = [['Build', 'Device, app, dashboard', true], ['Bench test', 'Signal quality, repeatability', false], ['Clinical validation', 'With clinicians, approved protocol', false], ['Field usability', 'Health workers, caregivers', false], ['Improve', 'Model, hardware, procedures', false]];
    const sw = (W - 2 * M) / 5;
    s.addShape(pres.shapes.LINE, { x: M + sw / 2, y: 2.45, w: sw * 4, h: 0, line: { color: 'CBD5E1', width: 3 }, objectName: 'timeline' });
    for (let i = 0; i < 5; i++) {
      const cx = M + i * sw + sw / 2;
      const isDone = steps[i][2];
      s.addShape(pres.shapes.OVAL, { x: cx - 0.45, y: 2.0, w: 0.9, h: 0.9, fill: { color: isDone ? C.accent5 : C.accent1 }, line: { color: 'FFFFFF', width: 3 }, objectName: 'step ' + (i + 1) });
      txt(s, isDone ? '✓' : String(i + 1), { x: cx - 0.45, y: 2.0, w: 0.9, h: 0.9, fontSize: 24, bold: true, color: C.background1, align: 'center', valign: 'middle' });
      txt(s, steps[i][0], { x: cx - sw / 2 + 0.1, y: 3.1, w: sw - 0.2, h: 0.85, fontSize: 22, bold: true, color: C.text2, align: 'center', valign: 'middle' });
      txt(s, steps[i][1], { x: cx - sw / 2 + 0.15, y: 4.05, w: sw - 0.3, h: 0.8, fontSize: 18, color: C.text1, align: 'center' });
      if (isDone) txt(s, 'Done', { x: cx - sw / 2 + 0.1, y: 4.85, w: sw - 0.2, h: 0.4, fontSize: 16, bold: true, color: C.accent5, align: 'center' });
    }
    card(s, M, 5.35, W - 2 * M, 1.0, C.background2, 'safeguards');
    await badge(s, 'shield-check', M + 0.25, 5.5, 0.7, C.accent1, 'safeguards icon');
    txt(s, 'Before real use: ethics approval, consent, privacy, clinical oversight', { x: M + 1.15, y: 5.5, w: W - 2 * M - 1.4, h: 0.7, fontSize: 20, color: C.text1, valign: 'middle' });
    s.addNotes('The build step is done. Next is bench testing, then clinical validation with qualified clinicians under an approved protocol, then field usability with health workers and caregivers, then improvement. Nothing is used on real children before ethics approval and consent are in place.');
  }
  {
    const s = dark('Conclusion');
    txt(s, '6 · Conclusion', { x: M, y: 0.28, w: 6, h: 0.35, fontSize: 16, bold: true, color: '5EEAD4' });
    txt(s, 'Help us take PneumoScreen to a validated pilot', { x: M, y: 0.6, w: 11.5, h: 1.5, fontSize: 40, bold: true, color: C.background1 });
    const asks = [['graduation-cap', 'Mentorship', 'Embedded, AI, product'], ['stethoscope', 'Clinical partners', 'Safe validation'], ['handshake', 'Pilots and funding', 'Field testing at scale']];
    const aw = (W - 2 * M - 2 * 0.45) / 3;
    for (let i = 0; i < 3; i++) {
      const x = M + i * (aw + 0.45);
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 2.6, w: aw, h: 2.6, rectRadius: 0.12, fill: { color: '1E293B' }, line: { type: 'none' }, objectName: asks[i][1] + ' card' });
      await badge(s, asks[i][0], x + 0.4, 2.95, 1.0, C.accent2, asks[i][1] + ' icon');
      txt(s, asks[i][1], { x: x + 0.4, y: 4.1, w: aw - 0.8, h: 0.5, fontSize: 24, bold: true, color: C.background1 });
      txt(s, asks[i][2], { x: x + 0.4, y: 4.6, w: aw - 0.8, h: 0.45, fontSize: 18, color: 'CBD5E1' });
    }
    txt(s, 'Early warning. Timely referral. Better-informed care.', { x: M, y: 5.75, w: 11, h: 0.6, fontSize: 24, italic: true, color: '5EEAD4' });
    s.addNotes('Close with the ask: technical mentorship, clinical partners for safe validation, and pilot partners and funding. End on the line: early warning, timely referral, better-informed care.');
  }
  pres.addSection({ title: 'References' });
  {
    const s = content('References', 'References and responsible use');
    const refs = [
      '[1] UNICEF. (n.d.). Pneumonia in children. UNICEF Data. Retrieved October 2026, from https://data.unicef.org/topic/child-health/pneumonia/',
      '[2] UN Inter-agency Group for Child Mortality Estimation. (2025). Levels and trends in child mortality: Report 2025. UNICEF.',
      '[3] World Health Organization. (2014). Integrated Management of Childhood Illness: Chart booklet. WHO.',
      '[4] World Health Organization. (2022). Pneumonia in children [Fact sheet]. https://www.who.int/news-room/fact-sheets/detail/pneumonia',
      '[5] Zhang, Q., et al. (2022). SPRSound: Open-source SJTU paediatric respiratory sound database. IEEE Transactions on Biomedical Circuits and Systems, 16(5), 867–881.',
    ];
    await badge(s, 'book-open', M, 1.6, 0.8, C.accent1, 'references icon');
    txt(s, refs.map((t, j) => ({ text: t, options: { breakLine: j < refs.length - 1 } })), { x: M + 1.1, y: 1.6, w: W - 2 * M - 1.1, h: 3.55, fontSize: 16, color: C.text1, paraSpaceAfter: 8 });
    card(s, M, 5.3, W - 2 * M, 1.05, 'FEF3C7', 'responsible use');
    txt(s, 'PneumoScreen is a research prototype, not a validated diagnostic device. It must not replace professional assessment or urgent care [4].', { x: M + 0.35, y: 5.4, w: W - 2 * M - 0.7, h: 0.85, fontSize: 18, color: '78350F', valign: 'middle' });
    s.addNotes('References in APA style, numbered as cited on the slides. The yellow note is the responsible-use statement.');
  }
  await pres.writeFile({ fileName: OUT });
  await applyTheme(OUT, THEME);
  console.log('wrote', OUT);
})().catch((e) => { console.error(e); process.exit(1); });
