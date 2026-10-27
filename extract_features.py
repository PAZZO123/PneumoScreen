# extract_features.py
# Compute 13 x 98 MFCCs (1,274 values) from the first 1 s of each segmented clip.
# Shape must match FEATURE_SIZE in the Arduino sketch.
import librosa, numpy as np, pandas as pd, pickle
from tqdm import tqdm

CLASSES = ['normal','crackles','wheezes']
SR, DUR = 16000, 1.0
N_MFCC, N_MELS = 13, 32
HOP = int(SR*0.010); WIN = int(SR*0.025)
N_FFT = WIN            # 400; librosa frames by n_fft, so this keeps 25 ms frames
CENTER = False         # no edge padding -> 1 + (16000-400)//160 = 98 frames

manifest = pd.read_csv('data/clips_manifest.csv')
X, y, groups = [], [], []
for _, row in tqdm(manifest.iterrows(), total=len(manifest)):
    audio, _ = librosa.load(row['path'], sr=SR, duration=DUR)
    tlen = int(SR*DUR)
    audio = np.pad(audio,(0,max(0,tlen-len(audio))))[:tlen]
    mfcc = librosa.feature.mfcc(y=audio, sr=SR, n_mfcc=N_MFCC, n_mels=N_MELS,
                                n_fft=N_FFT, hop_length=HOP, win_length=WIN, center=CENTER)
    X.append(mfcc.flatten()); y.append(CLASSES.index(row['label']))
    groups.append(row['patient_id'])

X, y, groups = np.array(X, dtype=np.float32), np.array(y), np.array(groups)
print('Feature matrix:', X.shape)
with open('features.pkl','wb') as f:
    pickle.dump({'X':X, 'y':y, 'classes':CLASSES, 'groups':groups,
                 'params':{'sr':SR, 'duration':DUR, 'n_mfcc':N_MFCC, 'n_mels':N_MELS,
                           'n_fft':N_FFT, 'win_length':WIN, 'hop_length':HOP,
                           'center':CENTER, 'frames':mfcc.shape[1]}}, f)
