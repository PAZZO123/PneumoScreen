# Plan: update the PneumoScreen deck

Source deck: `~/Downloads/PneumoScreen.pptx` (12 slides, concept pitch). Output: a new file, `PneumoScreen-v2.pptx`. The original is never overwritten.

## Why update it

The deck was written before the prototype worked. It now needs to show what was built (gateway, app, triage, dashboard) and a short demo. A render of the current deck also shows defects the pptx-design rules would reject:

| Problem | Where | Rule |
|---|---|---|
| Text cut off inside cards | slides 3, 4, 5, 6, 9, 10, 12 | No overflow |
| Body text about 10–12 pt; hard to read from the back | most slides | Main points 24–28 pt, secondary 18–20 pt |
| All-caps headings and statements | 1, 2, 3, 9, 11 | Avoid all caps |
| Line under every title | 3–10, 12 | No accent lines under titles |
| "Per day" vs "per year" deaths on one bar chart (2,000 looks like zero) | 4 | One clear question per graph |
| Workflow numbering skips 02 | 6 | Accuracy |
| TinyML on the board; the AI now runs on the phone | 5, 7 | Accuracy |
| IMCI chart leaves out < 2 months (≥ 60/min) | 8 | Accuracy |
| Prose paragraphs rather than point form | 3, 5, 9, 12 | Point form, 4–5 points |

## Design rules applied (pptx-design)

- **Pyramid:** hook → problem → solution → evidence/demo → conclusion and ask.
- **Length:** 14 slides for a 10–12 minute talk (1–2 slides per minute) plus a 90 s demo video.
- **Point form, ≤ 5 points, one message per slide; a visual on every slide** (icon, chart, diagram, screenshot or video).
- **Fonts:** Arial only. Titles 36–40 pt bold, main points 24 pt, secondary 18–20 pt, captions and sources 14 pt. Sentence case, no all caps.
- **Colour:** keep the deck's navy and teal. Navy `0F1E36` for dark slides; white content slides; teal `14B8A6` as the one accent. Red, amber and green appear **only** for triage meaning (danger, refer, normal).
- **Background sandwich:** dark title, demo and closing slides; light content slides.
- **Animation:** none, or "Appear" only.
- **Graphs:** "Figure N:" title, labelled axes with units, source caption.
- **References:** numbered [n] in slides, APA list on the last slide.

## Slide by slide

| # | Slide | Change | Visual |
|---|---|---|---|
| 1 | **2,000 children. Every day.** (hook) | Keep the message; sentence case; fewer words | Large stat, device motif |
| 2 | **PneumoScreen** title | Update subtitle: working prototype, not concept | Device + phone motif |
| 3 | **The problem: recognition and referral** | 700,000+ a year [1]; recognise → assess → refer, in 3 short points | 3 icon steps |
| 4 | **Why it matters** | Remove the misleading bar chart; 3 stat callouts: 2,000/day [1], 700,000+/yr [1], 13% of under-5 deaths [2] | Stat callouts |
| 5 | **Our solution** | 4 signals: lung sounds (AI), breath rate (motion), SpO₂ (planned), temperature (thermometer) | 2×2 icon grid |
| 6 | **How it works** (new) | Device → Bluetooth → app (AI + IMCI rules) → clinic server and dashboard | Architecture diagram |
| 7 | **The health worker's workflow** | 4 real steps: Patient → Vitals → Lungs → Triage | App screenshots in a row |
| 8 | **Age-aware breathing thresholds** | All 4 bands: 60 / 50 / 40 / 21 per min [3] | Figure 1: native bar chart |
| 9 | **Clear triage: normal, refer, danger** (new) | What triggers each level | 3 coloured cards with app screenshot |
| 10 | **What works today** (new) | Gateway recording over BLE with CRC check and resend; on-phone AI; triage; dashboard; 57 automated tests. Not yet: SpO₂ firmware, clinical validation; model accuracy 0.57 | Two columns: done / next |
| 11 | **Demo** (new, dark) | Embedded 90 s narrated video; poster frame; 2 still pictures beside it | Video + pictures |
| 12 | **Roadmap to a responsible pilot** | 5 steps, point form, no overflow | Timeline |
| 13 | **Our ask** (dark) | Mentorship, clinical partners, pilot funding | Device motif |
| 14 | **References and responsible use** | APA list [1]–[4]; "not a diagnostic device" note | Numbered list |

## Demo video (slide 11)

- **Length:** about 90 s, 1280×720 MP4 (H.264 + AAC). Small enough to embed (< 15 MB).
- **Footage:** the app in demo mode (simulated device), recorded from Chrome with a scripted run, so no real child's data appears. It is labelled *Demo data* on screen.
- **Scenes:**
  1. Sign in.
  2. Connect the gateway; sensor badges.
  3. Pick a child; age band and danger signs.
  4. Breathing rate with the countdown ring and the chest chart.
  5. A lung recording with the AI result and spectrogram.
  6. Triage result.
  7. The supervisor dashboard.
- **Sound:** a recorded voice-over, one sentence per scene (macOS speech for this version; replace it with a human voice later if you like).
- **In the deck:** the poster frame shows before play. It plays on click in PowerPoint, and the file is embedded, not linked.
- **Reserved space:** the slide keeps the video at 16:9 on the left and two picture slots on the right (dashboard, device photo). A real photo of the board can replace the placeholder picture later.

## Pictures to add

| Picture | Source | Slide |
|---|---|---|
| App screens (patient, vitals, lungs, triage) | Captured from the app in demo mode | 7, 9 |
| Supervisor dashboard | Captured from `server/` | 11 |
| The device (Arduino board on the shield) | **Needs a photo from you**: a clearly marked placeholder until then | 11 |

## Checks before handing over

- `validate.py` on the new deck, and a PowerPoint render of every slide, checked for overflow, overlap, contrast and alignment.
- Text QA for typos and leftover placeholder text.
- The video plays in PowerPoint (Slide Show).

## v3: the required structure (November 2026)

The talk must follow **problem → solution → technology → conclusion**, with a **demo** and **testing**. v3 keeps every v2 slide and its numbers, reorders them, adds signposting, and adds a testing section:

| Section | Slides |
|---|---|
| Opening | Hook (2,000 children a day), title, **agenda** (new) |
| 1 · Problem | The gap (700,000+ a year); three stat cards (2,000 / 700,000+ / 13%) |
| 2 · Solution | Four signals; the health worker's four steps; normal / refer / danger |
| 3 · Technology | How it works (device → phone → clinic server); WHO IMCI thresholds (Figure 1) |
| 4 · Demo | The re-voiced demo video (African-context voice-over), dashboard, device-photo slot |
| 5 · Testing (new) | How we tested: 62 automated tests, bit-exact match with the firmware, real-board recordings, end-to-end; lung-sound AI results (Figure 2: recall 77% / 72% / 63% in children with pneumonia; 0.57 overall; 8,096 windows, 516 patients; 20.8 KB) |
| 6 · Conclusion | What we have and what comes next; roadmap; the ask; references [1]–[5] |

Each content slide carries a small "N · Section" label above its title so the audience always knows where the talk is.
