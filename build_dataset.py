# build_dataset.py
# Builds the 4-class training set (normal / crackles / wheezes / noise) from ICBHI, SPRSound,
# HF_Lung_V1 and ESC-50 as 2 s windows, each with a clean and a "board microphone" copy
# (random filtering + background noise). Output: data/dataset_v2.npz
import glob, json, os, random, re, sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np, pandas as pd, librosa, scipy.signal as sig
from tqdm import tqdm
import pneumo_features as pf

SEED = 0
CAPS = {   # max windows per (dataset, class); None = keep all
    ('icbhi', 'normal'): 4000, ('sprsound', 'normal'): 5000, ('hf_lung', 'normal'): 4000,
    ('hf_lung', 'crackles'): 6000, ('hf_lung', 'wheezes'): 6000,
}
MIN_OVERLAP = 0.1   # s of overlap with an event before a window counts as containing it
EXT = 'data/external'


# ── Event tables: one row per (file, start, end, kind) with kind in normal/crackle/wheeze/both ──
def icbhi_events():
    rows = []
    for txt in glob.glob('data/audio_and_txt_files/*.txt'):
        wav = txt[:-4] + '.wav'; pid = os.path.basename(txt).split('_')[0]
        for line in open(txt):
            p = line.split()
            if len(p) < 4: continue
            c, w = int(p[2]), int(p[3])
            kind = 'both' if c and w else 'crackle' if c else 'wheeze' if w else 'normal'
            rows.append(dict(file=wav, start=float(p[0]), end=float(p[1]), kind=kind,
                             dataset='icbhi', group='icbhi_' + pid, diag='', age=np.nan))
    return rows


def sprsound_events():
    summ = pd.concat([pd.read_csv(p, dtype={'patient_num': str}) for p in glob.glob(f'{EXT}/sprsound/Patient Summary/*.csv')])
    summ['patient_num'] = summ.patient_num.str.zfill(8)
    info = summ.drop_duplicates('patient_num').set_index('patient_num')[['disease', 'age']].to_dict('index')
    kinds = {'Normal': 'normal', 'Fine Crackle': 'crackle', 'Coarse Crackle': 'crackle',
             'Wheeze': 'wheeze', 'Rhonchi': 'wheeze', 'Stridor': 'wheeze', 'Wheeze+Crackle': 'both'}
    rows = []
    for js in glob.glob(f'{EXT}/sprsound/BioCAS20*/**/*.json', recursive=True):
        d = json.load(open(js))
        if d.get('record_annotation') == 'Poor Quality' or not d.get('event_annotation'): continue
        wav = re.sub(r'_json([\\/])', r'_wav\1', js)[:-5] + '.wav'
        if not os.path.exists(wav): continue
        pid = os.path.basename(js).split('_')[0].zfill(8); meta = info.get(pid, {})
        for e in d['event_annotation']:
            rows.append(dict(file=wav, start=float(e['start']) / 1000, end=float(e['end']) / 1000,
                             kind=kinds[e['type']], dataset='sprsound', group='spr_' + pid,
                             diag=str(meta.get('disease', '')).strip().lower(), age=meta.get('age', np.nan)))
    return rows


def hf_lung_events():
    def secs(t):
        h, m, s = t.split(':'); return int(h) * 3600 + int(m) * 60 + float(s)
    kinds = {'I': 'normal', 'E': 'normal', 'D': 'crackle', 'C': 'wheeze', 'Wheeze': 'wheeze',
             'Rhonchi': 'wheeze', 'Stridor': 'wheeze'}
    rows = []
    for txt in glob.glob(f'{EXT}/hf_lung_v1/*/*_label.txt'):
        wav = txt.replace('_label.txt', '.wav'); name = os.path.basename(wav)
        date = re.search(r'(\d{8}|\d{4}-\d{2}-\d{2})', name).group(1).replace('-', '')
        for line in open(txt):
            p = line.split()
            if len(p) == 3 and p[0] in kinds:
                rows.append(dict(file=wav, start=secs(p[1]), end=secs(p[2]), kind=kinds[p[0]],
                                 dataset='hf_lung', group='hfl_' + date, diag='', age=np.nan))
    return rows


# ── Windows: 2 s, centred on short events, tiled along long ones; labelled by overlap ──
def windows_for(events):
    half = pf.WIN_S / 2; out = []
    for f, ev in events.groupby('file'):
        adv = ev[ev.kind != 'normal']
        seen = set()
        for e in ev.itertuples():
            dur = e.end - e.start
            centres = np.arange(e.start + half, e.end - half + 1e-6, 1.0) if dur >= pf.WIN_S else [(e.start + e.end) / 2]
            for c in centres:
                key = round(c * 2) / 2
                if key in seen: continue
                seen.add(key)
                ws, we = c - half, c + half
                ov = adv[(np.minimum(adv.end, we) - np.maximum(adv.start, ws)) > MIN_OVERLAP]
                k = set(ov.kind)
                if 'both' in k or {'crackle', 'wheeze'} <= k: continue
                label = 'crackles' if 'crackle' in k else 'wheezes' if 'wheeze' in k else 'normal'
                out.append(dict(file=f, centre=c, label=label, dataset=e.dataset, group=e.group,
                                diag=e.diag, age=e.age))
    return pd.DataFrame(out)


def noise_windows():
    meta = pd.read_csv(f'{EXT}/esc50/ESC-50-master/meta/esc50.csv')
    meta = meta[meta.category != 'breathing']
    out = []
    for r in meta.itertuples():
        for c in (1.0, 2.5, 4.0):
            out.append(dict(file=f'{EXT}/esc50/ESC-50-master/audio/{r.filename}', centre=c, label='noise',
                            dataset='esc50', group=f'esc_{r.src_file}', diag='', age=np.nan))
    for i in range(400):   # synthetic background: white / pink / brown noise at random levels
        out.append(dict(file=f'synthetic:{i}', centre=1.0, label='noise', dataset='synthetic',
                        group=f'syn_{i // 20}', diag='', age=np.nan))
    return pd.DataFrame(out)


# ── Audio + augmentation (runs in worker processes) ──
NOISE_POOL = None

def init_worker(pool_files):
    global NOISE_POOL
    NOISE_POOL = [librosa.load(p, sr=pf.SR)[0] for p in pool_files]


def coloured_noise(n, rng, kind=None):
    w = rng.standard_normal(n).astype(np.float32)
    kind = kind or rng.choice(['white', 'pink', 'brown'])
    if kind == 'white': return w
    f = np.fft.rfftfreq(n); f[0] = f[1]
    spec = np.fft.rfft(w) / (np.sqrt(f) if kind == 'pink' else f)
    x = np.fft.irfft(spec, n).astype(np.float32)
    return x / (x.std() + 1e-9)


def mic_simulation(x, rng, add_noise=True):
    """Random microphone/placement response plus background noise at 5-25 dB SNR."""
    hp = rng.uniform(60, 250); x = sig.lfilter(*sig.butter(1, hp / (pf.SR / 2), 'high'), x)
    if rng.random() < 0.7:
        lp = rng.uniform(700, 1900); x = sig.lfilter(*sig.butter(2, lp / (pf.SR / 2), 'low'), x)
    x = x.astype(np.float32)
    if add_noise:
        if NOISE_POOL and rng.random() < 0.7:
            src = NOISE_POOL[rng.integers(len(NOISE_POOL))]
            s = rng.integers(0, max(1, len(src) - len(x))); nz = pf.fit_length(src[s:s + len(x)])
        else:
            nz = coloured_noise(len(x), rng)
        snr = rng.uniform(5, 25)
        px, pn = np.mean(x ** 2) + 1e-12, np.mean(nz ** 2) + 1e-12
        x = x + nz * np.sqrt(px / (pn * 10 ** (snr / 10)))
    return x


def process_file(job):
    file, centres, seed = job
    rng = np.random.default_rng(seed)
    if file.startswith('synthetic:'):
        audio = coloured_noise(pf.N, rng) * rng.uniform(0.001, 0.3)
    else:
        try: audio = librosa.load(file, sr=pf.SR)[0]
        except Exception: return file, None, None
    clean, aug = [], []
    for c in centres:
        s = int(round((c - pf.WIN_S / 2) * pf.SR)); s = min(max(0, s), max(0, len(audio) - pf.N))
        x = pf.fit_length(audio[s:s + pf.N])
        clean.append(pf.mfcc(x))
        aug.append(pf.mfcc(mic_simulation(x, rng, add_noise=not file.startswith(('synthetic', EXT + '/esc50')))))
    return file, np.stack(clean).astype(np.float16), np.stack(aug).astype(np.float16)


if __name__ == '__main__':
    random.seed(SEED)
    print('Reading annotations...')
    ev = pd.DataFrame(icbhi_events() + sprsound_events() + hf_lung_events())
    print(ev.groupby(['dataset', 'kind']).size().unstack(fill_value=0))
    win = windows_for(ev)
    parts = []
    for (ds, lab), g in win.groupby(['dataset', 'label']):
        cap = CAPS.get((ds, lab))
        parts.append(g.sample(cap, random_state=SEED) if cap and len(g) > cap else g)
    win = pd.concat(parts + [noise_windows()], ignore_index=True)
    print('\nWindows per dataset and class:')
    print(win.groupby(['dataset', 'label']).size().unstack(fill_value=0))

    esc = pd.read_csv(f'{EXT}/esc50/ESC-50-master/meta/esc50.csv')
    pool = esc[(esc.category != 'breathing') & (esc.fold <= 3)].sample(300, random_state=SEED)
    pool_files = [f'{EXT}/esc50/ESC-50-master/audio/{f}' for f in pool.filename]

    win = win.sort_values(['file', 'centre']).reset_index(drop=True)
    jobs = [(f, list(g.centre), SEED + i) for i, (f, g) in enumerate(win.groupby('file', sort=False))]
    feats = {}
    workers = max(1, min(8, (os.cpu_count() or 2) - 1))
    with ProcessPoolExecutor(workers, initializer=init_worker, initargs=(pool_files,)) as ex:
        for f, c, a in tqdm(ex.map(process_file, jobs, chunksize=8), total=len(jobs), desc='files'):
            feats[f] = (c, a)

    keep, Xc, Xa = [], [], []
    for f, g in win.groupby('file', sort=False):
        c, a = feats[f]
        if c is None: continue
        keep.append(g); Xc.append(c); Xa.append(a)
    meta = pd.concat(keep, ignore_index=True)
    Xc, Xa = np.concatenate(Xc), np.concatenate(Xa)
    y = meta.label.map({c: i for i, c in enumerate(pf.CLASSES)}).to_numpy()
    np.savez_compressed('data/dataset_v2.npz', X_clean=Xc, X_aug=Xa, y=y, classes=np.array(pf.CLASSES),
                        group=meta.group.to_numpy(), dataset=meta.dataset.to_numpy(),
                        diag=meta.diag.fillna('').to_numpy(), age=meta.age.to_numpy(dtype=float),
                        source_file=meta.file.to_numpy(), centre=meta.centre.to_numpy())
    print('\nSaved data/dataset_v2.npz:', Xc.shape, 'per class:',
          dict(zip(pf.CLASSES, np.bincount(y, minlength=4).tolist())), 'skipped files:', len(jobs) - len(keep))
