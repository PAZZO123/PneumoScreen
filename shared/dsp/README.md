# @pneumo/dsp: lung-sound features and model on the phone

The board's old on-device pipeline, ported to TypeScript so the app can classify lung sounds offline. The board now only records (see `docs/BLE_PROTOCOL.md`).

```
4 kHz int16 PCM from the board ──▶ computeMfcc (13×124) ──▶ quantizeInput (int8)
                                ──▶ Interpreter (pneumo_lung_int8.tflite) ──▶ probabilities
```

## API

```ts
import { LungClassifier, evaluate, ageBand } from '@pneumo/dsp';

const clf = LungClassifier.fromBytes(await (await fetch('/pneumo_lung_int8.tflite')).arrayBuffer());
const r = clf.classifyClip(pcm);      // Int16Array, 4 kHz, e.g. StepData.audio from @pneumo/protocol
// r.best: 'normal' | 'crackles' | 'wheezes' | 'noise' | null
// r.quality: 'ok' | 'silent' | 'short' | 'noise'  → anything but 'ok' means "offer Re-record"
// r.probs: averaged probabilities; r.windows: per-window detail

const result = evaluate({
  ageBand: ageBand(dateOfBirth),            // 0 <2 mo, 1 2–12 mo, 2 1–5 y, 3 >5 y
  breathBpm: 44,
  lung: { RU: 'normal', LU: 'crackles', RL: 'normal', LL: 'normal' },
  spo2: 96,
});
// result.refer, result.reasons[], result.missing[], result.complete, result.rulesVersion
```

Lower level: `computeMfcc(Float32Array(8000))`, `quantizeInput`, `Decimator` (16 kHz to 4 kHz, the same filter the board uses), `TfliteModel` / `Interpreter`.

`classifyClip` uses the board's `lung_update()` scheme: 2 s windows every 1 s, skipping windows below RMS 0.005, and averaging the dequantized outputs over the windows it keeps.

## Parity with the board and TFLite

`pnpm --filter @pneumo/dsp test` checks against references generated from the firmware's own `mfcc.cpp` and TFLite's reference kernels. The current results, on 16 windows (12 ICBHI clips plus noise, sine, silence and clipping):

| Check | Result |
|---|---|
| Decimator vs C++ | < 1e-6 |
| MFCC vs C++ `compute_mfcc` | bit-exact (max diff 0) |
| Quantizer vs C++ `quantize_input` | exact |
| Model logits vs TFLite `BUILTIN_REF` | bit-exact |
| Softmax vs TFLite | 0 steps (float softmax; at most 1 step by design) |
| Class, end to end from 4 kHz PCM | 16 / 16 match |

The interpreter is a small pure-TypeScript int8 TFLite runtime, not `@tensorflow/tfjs-tflite`. It runs unchanged in the Android and iOS web views and in Node tests, needs no WASM, and reads the `.tflite` file directly, so a retrained model only needs copying. It supports `CONV_2D`, `MAX_POOL_2D`, `REDUCE_MAX`, `FULLY_CONNECTED`, `SOFTMAX` and `RESHAPE`, and throws on anything else.

Model accuracy is a separate question from parity: the int8 model scores 0.569 on the test set (`models/training_report.md`).

## Regenerating

- **Tables** (`src/generated/*.json`) come from `firmware/pneumoscreen/dsp_tables.h` and `model.h`:
  `pnpm --filter @pneumo/dsp extract`. A test fails if they are stale.
- **Fixtures** (`fixtures/`) need g++, the ICBHI clips in `data/`, and a Python with `ai-edge-litert` and `numpy<2` (e.g. a throwaway Python 3.9 venv):
  `python shared/dsp/scripts/make_fixtures.py`

The model file `models/pneumo_lung_int8.tflite` is git-ignored like the other models. The model tests are skipped when it is missing, and the app bundles its own copy.
