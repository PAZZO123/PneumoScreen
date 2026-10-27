# PneumoScreen

Low-cost pneumonia screening device for Community Health Workers, built on the **Arduino Nano 33 BLE Sense** (Arduino TinyML Kit AKX00028).

It combines four signals:

| Signal | Sensor | Method |
|---|---|---|
| Lung sounds (normal / crackles / wheezes) | Built-in PDM microphone | MFCC features → TinyML model |
| Breath rate | Built-in accelerometer (on chest) or OV7670 camera (contactless) | Peak detection / frame differencing |
| SpO2 + heart rate | MAX30102 | Sensor library algorithm |
| Temperature | External body-temperature sensor | Direct reading |

Results stream over USB serial to a live web dashboard.

## Repository layout

```
preprocess_icbhi.py        Segment ICBHI recordings into per-breath-cycle clips (16 kHz)
extract_features.py        13 x 98 MFCC features (1,274 values) per clip -> features.pkl
tools/download_data.py     Download and extract all datasets into data/
tools/record_board.py      Record labelled audio from the board's microphone
firmware/record_audio/     Sketch that streams the board's microphone to the PC
```

`data/` and `features.pkl` are not in the repository; they are created by the steps below.

## Setup

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt      # Windows
# source .venv/bin/activate && pip install -r requirements.txt  # macOS / Linux
```

Arduino: install the **Arduino Mbed OS Nano Boards** core (Boards Manager → "Nano 33 BLE").

## Getting the data

```bash
.venv/Scripts/python tools/download_data.py          # ~6 GB download, ~5.5 GB on disk
.venv/Scripts/python preprocess_icbhi.py             # -> data/normal, data/crackles, data/wheezes
.venv/Scripts/python extract_features.py             # -> features.pkl
```

Use `--only <name>` to fetch a single dataset (names below).

| Name | Dataset | Contents | Licence |
|---|---|---|---|
| `icbhi` | [ICBHI 2017 Respiratory Sound Database](https://bhichallenge.med.auth.gr) ([Kaggle mirror](https://www.kaggle.com/datasets/vbookshelf/respiratory-sound-database)) | 920 recordings, 126 patients, 6,898 annotated breath cycles | Research use |
| `hf_lung_v1` | [HF_Lung_V1](https://gitlab.com/techsupportHF/HF_Lung_V1) | 9,765 × 15 s recordings, 279 adults; crackle, wheeze, rhonchi, stridor events | CC BY 4.0 |
| `kauh` | [KAUH lung sounds](https://data.mendeley.com/datasets/jwyy9np4gv) | 336 recordings, 112 adults incl. 5 pneumonia | CC BY 4.0 |
| `sprsound` | [SPRSound](https://github.com/SJTU-YONGFU-RESEARCH-GRP/SPRSound) | 6,567 recordings, 869 children (445 with pneumonia) | CC BY 4.0 |
| `esc50` | [ESC-50](https://github.com/karolpiczak/ESC-50) | 2,000 environmental sound clips (noise class) | CC BY-NC 3.0 |

ESC-50's `breathing` category is normal breathing and should be left out of the noise class.

### MFCC settings (must match the firmware)

| Parameter | Value |
|---|---|
| Sample rate | 16,000 Hz |
| Window | first 1 s of each clip (zero-padded) |
| Frame / hop | 400 samples (25 ms) / 160 samples (10 ms) |
| FFT size | 400, no centre padding |
| Mel filters / coefficients | 32 / 13 |
| Output | 13 × 98 = 1,274 values (`FEATURE_SIZE` in the sketch) |

## Recording from the board (optional)

Upload `firmware/record_audio/record_audio.ino`, then:

```bash
.venv/Scripts/python tools/record_board.py test                          # check microphone level
.venv/Scripts/python tools/record_board.py record --label noise_room --seconds 10 --takes 5
.venv/Scripts/python tools/record_board.py replay --per-class 50         # replay ICBHI clips through a speaker
```

Recordings are saved under `data/device/` with a manifest CSV.

## Project phases

0. Hardware and tools setup
1. Data (datasets, segmentation, features) — **done**
2. Lung-sound model training
3. On-device audio pipeline (PDM capture, MFCC, inference)
4. Vital signs: breath rate, SpO2, temperature
5. Full firmware integration and alert logic
6. Web dashboard
7. Testing, demo and documentation

## Citations

- Rocha, B.M. et al. (2019). An open access database for the evaluation of respiratory sound classification algorithms. *Physiological Measurement*, 40(3).
- Hsu, F.-S. et al. (2021). Benchmarking of eight recurrent neural network variants for breath phase and adventitious sound detection on a self-developed open-access lung sound database — HF_Lung_V1. *PLOS ONE*, 16(7).
- Fraiwan, M. et al. (2021). A dataset of lung sounds recorded from the chest wall using an electronic stethoscope. *Data in Brief*, 35.
- Zhang, Q. et al. (2022). SPRSound: Open-Source SJTU Paediatric Respiratory Sound Database. *IEEE TBioCAS*, 16(5).
- Piczak, K.J. (2015). ESC: Dataset for Environmental Sound Classification. *ACM Multimedia*.
