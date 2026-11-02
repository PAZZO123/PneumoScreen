#!/usr/bin/env python3
"""Generate the parity fixtures in shared/dsp/fixtures/.

Reference = the firmware's C++ (scripts/fixture_host.cpp + mfcc.cpp) for the
decimator, MFCC and quantizer, and TFLite's *reference* kernels
(OpResolverType.BUILTIN_REF, no XNNPACK) for the model.

Needs: g++, numpy, ai-edge-litert (with numpy<2), the ICBHI clips in data/,
and models/pneumo_lung_int8.tflite. Run from the repo root:
    python shared/dsp/scripts/make_fixtures.py
"""
import glob, json, os, struct, subprocess, sys, tempfile, wave

import numpy as np
from ai_edge_litert.interpreter import Interpreter, OpResolverType

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
OUT = os.path.join(ROOT, 'shared', 'dsp', 'fixtures')
MODEL = os.path.join(ROOT, 'models', 'pneumo_lung_int8.tflite')
PER_CLASS = 4
N_DECIM = 2


def load_window(path):
    with wave.open(path) as w:
        assert w.getframerate() == 16000 and w.getsampwidth() == 2 and w.getnchannels() == 1, path
        a = np.frombuffer(w.readframes(w.getnframes()), '<i2')
    out = np.zeros(32000, np.int16)
    out[:min(32000, len(a))] = a[:32000]
    return out


def main():
    windows, labels = [], []
    for cls in ('normal', 'crackles', 'wheezes'):
        files = sorted(glob.glob(os.path.join(ROOT, 'data', cls, '*.wav')))
        for f in files[:: max(1, len(files) // PER_CLASS)][:PER_CLASS]:
            windows.append(load_window(f)); labels.append(f'{cls}/{os.path.basename(f)}')
    rng = np.random.default_rng(7)
    windows.append((rng.normal(0, 3000, 32000)).clip(-32768, 32767).astype(np.int16)); labels.append('synthetic/noise')
    t = np.arange(32000) / 16000
    windows.append((9000 * np.sin(2 * np.pi * 300 * t)).astype(np.int16)); labels.append('synthetic/sine300')
    windows.append(np.zeros(32000, np.int16)); labels.append('synthetic/silence')
    windows.append((rng.normal(0, 30000, 32000)).clip(-32768, 32767).astype(np.int16)); labels.append('synthetic/clipping')
    n = len(windows)

    with tempfile.TemporaryDirectory() as tmp:
        exe = os.path.join(tmp, 'fixture_host')
        fw = os.path.join(ROOT, 'firmware', 'pneumoscreen')
        subprocess.run(['g++', '-O2', '-ffp-contract=off', '-I', fw,
                        os.path.join(ROOT, 'shared', 'dsp', 'scripts', 'fixture_host.cpp'),
                        os.path.join(fw, 'mfcc.cpp'), '-lm', '-o', exe], check=True)
        stdin = struct.pack('<I', n) + b''.join(w.astype('<i2').tobytes() for w in windows)
        res = subprocess.run([exe], input=stdin, capture_output=True, check=True).stdout

    rec = 8000 * 4 + 8000 * 2 + 1612 * 4 + 1612
    assert len(res) == n * rec, (len(res), n * rec)
    dec, pcm, mfcc, q = [], [], [], []
    for i in range(n):
        b = res[i * rec:(i + 1) * rec]
        o = 0
        dec.append(np.frombuffer(b, '<f4', 8000, o)); o += 32000
        pcm.append(np.frombuffer(b, '<i2', 8000, o)); o += 16000
        mfcc.append(np.frombuffer(b, '<f4', 1612, o)); o += 1612 * 4
        q.append(np.frombuffer(b, 'i1', 1612, o))

    it = Interpreter(MODEL, experimental_op_resolver_type=OpResolverType.BUILTIN_REF,
                     experimental_preserve_all_tensors=True)
    it.allocate_tensors()
    inp = it.get_input_details()[0]['index']
    outp = it.get_output_details()[0]['index']
    tensor_by_name = {t['name']: t['index'] for t in it.get_tensor_details()}
    logits_idx = next(i for nme, i in tensor_by_name.items() if nme.startswith('functional_1/dense_1/MatMul;'))
    logits, probs = [], []
    for qi in q:
        it.set_tensor(inp, qi.reshape(1, 13, 124, 1))
        it.invoke()
        logits.append(it.get_tensor(logits_idx).reshape(4).copy())
        probs.append(it.get_tensor(outp).reshape(4).copy())

    os.makedirs(OUT, exist_ok=True)
    np.concatenate(windows[:N_DECIM]).astype('<i2').tofile(os.path.join(OUT, 'decim_in.i16'))
    np.concatenate(dec[:N_DECIM]).astype('<f4').tofile(os.path.join(OUT, 'decim_out.f32'))
    np.concatenate(pcm).astype('<i2').tofile(os.path.join(OUT, 'pcm4k.i16'))
    np.concatenate(mfcc).astype('<f4').tofile(os.path.join(OUT, 'mfcc.f32'))
    np.concatenate(q).astype('i1').tofile(os.path.join(OUT, 'input.i8'))
    np.concatenate(logits).astype('i1').tofile(os.path.join(OUT, 'logits.i8'))
    np.concatenate(probs).astype('i1').tofile(os.path.join(OUT, 'probs.i8'))
    names = ['normal', 'crackles', 'wheezes', 'noise']
    manifest = {
        'generated_by': 'shared/dsp/scripts/make_fixtures.py',
        'reference': 'firmware mfcc.cpp (g++ -O2 -ffp-contract=off) + TFLite BUILTIN_REF kernels',
        'windows': n, 'decim_windows': N_DECIM, 'labels': labels,
        'ref_classes': [names[int(np.argmax(p))] for p in probs],
    }
    with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')
    print(f'wrote {n} windows to {OUT}')
    for lab, cls, p in zip(labels, manifest['ref_classes'], probs):
        print(f'  {lab:55s} -> {cls:8s} {list(p)}')


if __name__ == '__main__':
    sys.exit(main())
