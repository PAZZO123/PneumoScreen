# Lung-sound model training report (2026-10-28)

- Windows: train 28333 (+28333 microphone-simulated), validation 4048, test 8096
- Patients/groups: train 1784, test 516 (no overlap)
- Epochs run: 32, training time 140.1 min
- Model size: 20.8 KB (int8 TFLite)

## Test accuracy

| Model | Accuracy |
|---|---|
| float32 | 0.573 |
| int8 (on-device) | 0.569 |
| int8 on microphone-simulated audio | 0.531 |

## Per class (int8)

```
              precision    recall  f1-score   support

      normal      0.526     0.513     0.519      2600
    crackles      0.482     0.475     0.479      2461
     wheezes      0.525     0.563     0.543      1779
       noise      0.896     0.881     0.888      1256

    accuracy                          0.569      8096
   macro avg      0.608     0.608     0.607      8096
weighted avg      0.570     0.569     0.570      8096

```

## Confusion matrix (rows = true, columns = predicted)

```
               normal  crackles   wheezes     noise
     normal      1333       823       384        60
   crackles       799      1169       480        13
    wheezes       327       396      1001        55
      noise        75        35        40      1106
```

## Accuracy by dataset (int8)

| Dataset | Windows | Accuracy |
|---|---|---|
| esc50 | 1176 | 0.873 |
| hf_lung | 3818 | 0.474 |
| icbhi | 1203 | 0.411 |
| sprsound | 1819 | 0.660 |
| synthetic | 80 | 0.988 |

## Children with pneumonia (SPRSound test patients)

| True class | Windows | Recall |
|---|---|---|
| normal | 458 | 0.771 |
| crackles | 130 | 0.715 |
| wheezes | 81 | 0.630 |
