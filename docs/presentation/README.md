# Presentation and demo video

| File | What |
|---|---|
| [DECK_PLAN.md](DECK_PLAN.md) | The plan for deck v2: what changed from the concept deck and why (pptx-design rules) |
| `PneumoScreen-demo.mp4` | 75 s narrated demo (1280×720, H.264 + AAC), simulated sensor data |
| `demo-narration.json` | The voice-over script, one line per scene |
| `images/` | App and dashboard screenshots from the demo run, the video poster frame |
| `tools/record.mjs` | Records the demo: drives Chrome (puppeteer-core) through a screening and the dashboard |
| `tools/build-deck.js` | Builds `PneumoScreen-v2.pptx` (pptxgenjs) and embeds the video and screenshots |

The deck itself is `~/Downloads/PneumoScreen-v2.pptx`; the original `PneumoScreen.pptx` is unchanged.

## Re-recording the demo

The recording uses its own throwaway server and database, so no real records are touched:

1. Seed a scratch data folder: `PNEUMO_DATA_DIR=<dir> node server/scripts/seed.ts`, then `demo.ts`.
2. Start it: `PNEUMO_DATA_DIR=<dir> PORT=8788 node server/src/main.ts`.
3. Start the app against it: `PNEUMO_API=http://localhost:8788 pnpm --filter @pneumo/app exec vite --port 5174`.
4. Make the voice clips with macOS `say` (Samantha, rate 172) from `demo-narration.json`.
5. `node tools/record.mjs` (needs `puppeteer-core` and Google Chrome), then encode the frames and voice track with ffmpeg.

Replace the device-photo placeholder on slide 11 with a real photo of the board when you have one.
