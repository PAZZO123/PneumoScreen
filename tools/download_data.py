# download_data.py
# Download and extract every dataset PneumoScreen uses (about 6 GB of downloads, 5.5 GB extracted).
#
#   python tools/download_data.py                 # all datasets
#   python tools/download_data.py --only kauh esc50
#   python tools/download_data.py --keep-archives # keep the .zip/.7z files after extracting
import argparse, json, os, shutil, sys, urllib.request, zipfile

UA = {'User-Agent': 'Mozilla/5.0'}


def fetch(url, dest):
    """Stream url to dest, resuming a partial download if one exists."""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    have = os.path.getsize(dest) if os.path.exists(dest) else 0
    req = urllib.request.Request(url, headers={**UA, **({'Range': f'bytes={have}-'} if have else {})})
    try:
        r = urllib.request.urlopen(req, timeout=60)
    except urllib.error.HTTPError as e:
        if e.code == 416: return dest                      # already complete
        raise
    mode = 'ab' if have and r.status == 206 else 'wb'
    done = have if mode == 'ab' else 0
    total = r.headers.get('Content-Length')
    total = int(total) + done if total else None
    with open(dest, mode) as f:
        while chunk := r.read(1 << 20):
            f.write(chunk); done += len(chunk)
            msg = f'{done / 1e6:8.0f} MB' + (f' / {total / 1e6:.0f} MB' if total else '')
            print(f'\r  {os.path.basename(dest)}: {msg}', end='', flush=True)
    print()
    return dest


def check_path(root, rel):
    out = os.path.realpath(os.path.join(root, rel))
    if not out.startswith(os.path.realpath(root) + os.sep):
        raise SystemExit(f'Unsafe path in archive: {rel}')
    return out


def unzip(path, dest, select=lambda name: name):
    """Extract a zip; select(name) returns the output path relative to dest, or None to skip."""
    with zipfile.ZipFile(path) as z:
        if z.testzip(): raise SystemExit(f'Corrupt archive: {path}')
        for i in z.infolist():
            rel = select(i.filename)
            if i.is_dir() or not rel: continue
            out = check_path(dest, rel)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with z.open(i) as s, open(out, 'wb') as d: shutil.copyfileobj(s, d)


def icbhi(root, dl):
    # Kaggle mirror of the ICBHI 2017 database (the official server is often unreachable)
    z = fetch('https://www.kaggle.com/api/v1/datasets/download/vbookshelf/respiratory-sound-database',
              f'{dl}/respiratory-sound-database.zip')
    pre = 'Respiratory_Sound_Database/Respiratory_Sound_Database/'
    unzip(z, f'{root}/data', lambda n: n[len(pre):] if n.startswith(pre)
          else n if n == 'demographic_info.txt' else None)
    return [z]


def hf_lung_v1(root, dl):
    import py7zr, multivolumefile
    base = 'https://gitlab.com/techsupportHF/HF_Lung_V1/-/raw/master/'
    parts = {'test': 3, 'train': 10}
    files = [f'{s}.7z.{i:03d}' for s, n in parts.items() for i in range(1, n + 1)]
    got = [fetch(base + f, f'{dl}/hf_lung_v1/{f}') for f in files + ['LICENSE', 'README.md', 'Disclaimer']]
    dest = f'{root}/data/external/hf_lung_v1'
    os.makedirs(dest, exist_ok=True)
    for s in parts:
        with multivolumefile.open(f'{dl}/hf_lung_v1/{s}.7z', mode='rb') as vol:
            with py7zr.SevenZipFile(vol, 'r') as a:
                for n in a.getnames(): check_path(dest, n)
                a.extractall(dest)
    for f in ['LICENSE', 'README.md', 'Disclaimer']:
        shutil.copy2(f'{dl}/hf_lung_v1/{f}', dest)
    return got


def kauh(root, dl):
    meta = json.load(urllib.request.urlopen(urllib.request.Request(
        'https://data.mendeley.com/public-api/datasets/jwyy9np4gv', headers=UA), timeout=60))
    dest = f'{root}/data/external/kauh'
    got = []
    for f in meta['files']:
        name = f['filename'].replace(' ', '_')
        p = fetch(f['content_details']['download_url'], f'{dl}/kauh/{name}')
        if name.endswith('.zip'):
            unzip(p, dest); got.append(p)
        else:
            os.makedirs(dest, exist_ok=True); shutil.copy2(p, dest)
    return got


def sprsound(root, dl):
    z = fetch('https://codeload.github.com/SJTU-YONGFU-RESEARCH-GRP/SPRSound/zip/refs/heads/main',
              f'{dl}/SPRSound-main.zip')
    # The Classification/Detection/Compression folders repeat the BioCAS20xx recordings; skip them.
    keep = ('BioCAS2022/', 'BioCAS2023/', 'BioCAS2024/', 'BioCAS2025/', 'Patient Summary/', 'README.md', 'LICENSE')
    def select(n):
        rel = n.split('/', 1)[1] if '/' in n else ''
        return rel if rel.startswith(keep) else None
    unzip(z, f'{root}/data/external/sprsound', select)
    return [z]


def esc50(root, dl):
    z = fetch('https://github.com/karolpiczak/ESC-50/archive/refs/heads/master.zip', f'{dl}/ESC-50-master.zip')
    unzip(z, f'{root}/data/external/esc50')
    return [z]


DATASETS = {   # name: (function, folder that exists once it is done)
    'icbhi':      (icbhi,      'data/audio_and_txt_files'),
    'hf_lung_v1': (hf_lung_v1, 'data/external/hf_lung_v1/train'),
    'kauh':       (kauh,       'data/external/kauh'),
    'sprsound':   (sprsound,   'data/external/sprsound/BioCAS2022'),
    'esc50':      (esc50,      'data/external/esc50/ESC-50-master'),
}

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', nargs='+', choices=DATASETS)
    ap.add_argument('--root', default='.', help='project folder (default: current folder)')
    ap.add_argument('--keep-archives', action='store_true')
    args = ap.parse_args()
    dl = os.path.join(args.root, 'data', 'downloads')

    for name in args.only or DATASETS:
        fn, marker = DATASETS[name]
        if os.path.exists(os.path.join(args.root, marker)):
            print(f'[{name}] already present, skipping'); continue
        print(f'[{name}] downloading...')
        archives = fn(args.root, dl)
        if not args.keep_archives:
            for a in archives: os.remove(a)
        print(f'[{name}] done')
    if os.path.isdir(dl) and not args.keep_archives:
        shutil.rmtree(dl, ignore_errors=True)
    print('Next: python preprocess_icbhi.py && python extract_features.py', file=sys.stderr)
