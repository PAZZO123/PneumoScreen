# preprocess_icbhi.py
# Segment ICBHI 2017 recordings into per-cycle clips (normal / crackles / wheezes) at 16 kHz.
# Cycles labelled with both crackles and wheezes are skipped.
import os, csv, librosa, soundfile as sf, pandas as pd
from tqdm import tqdm

AUDIO_DIR  = 'data/audio_and_txt_files/'
OUTPUT_DIR = 'data/'
SR         = 16000
MIN_SAMPLES = int(0.1 * SR)   # drop empty/near-empty cycles (annotations past end of audio)
for cls in ['normal','crackles','wheezes']:
    os.makedirs(OUTPUT_DIR + cls, exist_ok=True)

count = {'normal':0, 'crackles':0, 'wheezes':0}
skipped = {'both':0, 'too_short':0}
manifest = []
for fname in tqdm(sorted(os.listdir(AUDIO_DIR))):
    if not fname.endswith('.wav'): continue
    base     = fname.replace('.wav', '')
    wav_path = os.path.join(AUDIO_DIR, fname)
    txt_path = os.path.join(AUDIO_DIR, base + '.txt')
    if not os.path.exists(txt_path): continue
    audio, _ = librosa.load(wav_path, sr=SR)
    df = pd.read_csv(txt_path, sep='\t', header=None,
                     names=['start','end','crackle','wheeze'])
    for _, row in df.iterrows():
        s, e = int(row['start']*SR), int(row['end']*SR)
        clip = audio[s:e]
        if   row['crackle']==1 and row['wheeze']==0: label='crackles'
        elif row['wheeze']==1 and row['crackle']==0: label='wheezes'
        elif row['crackle']==0 and row['wheeze']==0: label='normal'
        else: skipped['both'] += 1; continue
        if len(clip) < MIN_SAMPLES: skipped['too_short'] += 1; continue
        out = f'{OUTPUT_DIR}{label}/{base}_{count[label]}.wav'
        sf.write(out, clip, SR)
        manifest.append([out, label, base.split('_')[0], base, round(len(clip)/SR, 3)])
        count[label] += 1

with open(OUTPUT_DIR + 'clips_manifest.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['path','label','patient_id','recording','duration_s'])
    w.writerows(manifest)
print('Clips segmented:', count)
print('Skipped:', skipped)
