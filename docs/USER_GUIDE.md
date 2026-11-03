# PneumoScreen user guide

PneumoScreen helps a community health worker (CHW) screen a child for signs of pneumonia and decide whether to refer. It has three parts:

| Part | Where it runs | Who uses it |
|---|---|---|
| **Device** (Arduino Nano 33 BLE Sense, the gateway) | On the child: belly or chest | Health worker |
| **Screening app** (`app/`) | Phone or laptop, Chrome or Edge | Health worker |
| **Clinic server and dashboard** (`server/`) | Laptop at the clinic | Supervisor |

The device records each step and sends it to the app over Bluetooth. The app guides the worker, runs the lung-sound AI on the phone, applies the WHO IMCI rules, and saves everything to the clinic server.

> PneumoScreen is a prototype for research and demonstration. It is not a validated medical device. Clinical decisions stay with trained health workers and local guidelines.

---

## 1. Default users

`seed` creates two demo accounts on a new server:

| Username | Role | Sees | Use it for |
|---|---|---|---|
| `supervisor` | Supervisor | Every child and screening, analytics for all workers | The clinic dashboard; checking any worker's screenings |
| `chw1` | Health worker | Only the children assigned to them | The screening app |

**Passwords** are random. They are written to `server/.env.local` (git-ignored, readable only by you), never to the screen:

```
SUPERVISOR_USERNAME=supervisor
SUPERVISOR_PASSWORD=…
CHW1_USERNAME=chw1
CHW1_PASSWORD=…
```

To choose a password you can type easily, run this and type it twice. Nothing is shown while you type:

```bash
pnpm --filter @pneumo/server passwd chw1
```

This signs that user out on every device. After it, the old password in `server/.env.local` no longer works.

If sign-in fails ten times in five minutes, that account is blocked for five minutes.

---

## 2. Start everything (laptop)

You need Node 24 and pnpm 9. From the repository folder:

```bash
pnpm install
```

First time only: create the accounts, and optionally some demo children:

```bash
pnpm --filter @pneumo/server seed
```

```bash
pnpm --filter @pneumo/server demo
```

Every time, start the clinic server (port 8787) and leave it running:

```bash
pnpm --filter @pneumo/server start
```

Then start the screening app (port 5173) in a second terminal:

```bash
pnpm --filter @pneumo/app dev
```

| Open | For |
|---|---|
| http://localhost:5173 | Screening app (health worker) |
| http://localhost:8787 | Clinic dashboard (supervisor) |

The app loads the lung model from `models/pneumo_lung_int8.tflite`, which is not in git. Copy it there before the first run.

Use **Chrome or Edge in a normal tab**. Bluetooth does not work in Safari or Firefox, or inside "phone simulator" extensions.

---

## 3. Health worker: screen a child

### 3.1 Sign in and connect the device

1. Open the app and sign in (for example `chw1`).
2. Switch the device on. In the **PneumoScreen gateway** card, tap **Connect PneumoScreen Gateway**.
3. In Chrome's list, choose **PneumoScreen** and tap **Pair**.
4. The card turns green: *Ready · 5/5 sensors OK*. Badges show each sensor: Microphone, Motion sensor, Temperature, Pulse oximeter, Screen.

**After that, the app reconnects by itself.** If the device is reset, switched off or goes out of range, the header shows **Reconnecting…** and the app links up again when the device comes back. Reloading the page reconnects to the same device without the list (on Chrome versions that support it).

The header also shows the **Server** cloud. A red **Offline** badge means the clinic server can't be reached, so results won't save.

### 3.2 Choose the child

- Search by name, guardian or village, then tap the child.
- Or tap **Register a new child**: name, date of birth, sex, guardian, phone, village.
- An **unfinished** tag means an earlier screening is missing steps.

### 3.3 Step 1: Patient

- Check the age group. It comes from the date of birth and sets the WHO fast-breathing threshold:

  | Age | Fast breathing |
  |---|---|
  | Under 2 months | 60 or more per minute |
  | 2 to 12 months | 50 or more |
  | 1 to 5 years | 40 or more |
  | Over 5 years | 21 or more |

- Tick any **general danger sign** you see or the caregiver reports: not able to drink or breastfeed, vomits everything, convulsions, lethargic or unconscious, chest indrawing, stridor when calm. Any one of them means urgent referral.
- **Previous screenings** lists the child's last visits.
- Tap **Start screening**.

### 3.4 Step 2: Vital signs (any order)

| Card | What to do | Time |
|---|---|---|
| **Respiratory rate** | Lay the device flat on the belly, below the ribs. Keep the child calm and don't hold the device. Tap **Record 30 s**. | 30 s |
| **SpO₂ and heart rate** | Pulse sensor on the big toe or finger. Tap **Record 15 s**. The current firmware cannot read the MAX30102 yet, so on the real device this card says *not found*; tap **Skip**. | 15 s |
| **Temperature** | Type the **thermometer** reading. The **Record** button under *Room temperature* reads the device's sensor: that is the room, not the child. | — |

A big countdown ring shows the seconds left. The chest-movement chart marks each breath the device counted. Tap **Record again** if the reading looks wrong. Every attempt is kept.

### 3.5 Step 3: Lung sounds (4 positions)

1. Tap a position on the chest picture: 1 right upper, 2 left upper, 3 right lower, 4 left lower (the child's own right and left).
2. Put the microphone on bare skin, keep the room quiet, and tap **Record 10 s**.
3. Watch the **microphone level** bar. *Good contact* is green; *Very quiet* means press gently.
4. The result shows **Normal**, **Crackles**, **Wheezes** or **Noise**, with probability bars, the waveform and spectrogram, and a player to listen back.
5. **Noise** means record again. The app moves to the next position by itself.

### 3.6 Step 4: Triage

| Result | Means | Action |
|---|---|---|
| 🔴 **DANGER** | A danger sign, SpO₂ under 90%, or fever with crackles | Send to the health facility **now** |
| 🟡 **REFER** | Fast breathing, crackles or wheezes, or fever (38 °C or more) | Refer **today** |
| 🟢 **NORMAL** | None of the above in what was recorded | Follow local guidance |

If steps are missing, the result says so; record them and it updates. Tap **Finish and save**. The screening, every attempt and every recording go to the clinic server.

### 3.7 Demo mode (no device)

Tick **Simulate BLE data** in the gateway card, then **Connect simulated gateway**. A blue bar shows *Demo mode*. Simulated screenings are labelled **demo** and must never be used for a real child. Synthetic lung sounds usually come out as *Noise*; that is the real model judging fake audio.

---

## 4. Supervisor: the clinic dashboard

Open http://localhost:8787 and sign in as `supervisor`.

- **Overview:** babies, screenings, complete or incomplete, referred, refer rate; **Follow up** lists incomplete screenings with their missing steps; screenings per day, per worker, and devices seen.
- **Babies:** search, then open a child for breath-rate, SpO₂ and temperature trends and every visit.
- **A visit:** each step and every attempt, model output, which attempt was accepted, and playable recordings. **Watch live** follows a screening while the phone records it.

---

## 5. Troubleshooting

| Problem | Fix |
|---|---|
| *Wrong username or password* | Copy the password from `server/.env.local`, or set a new one with `passwd` (section 1). Chrome may autofill an old one: clear the box. |
| *Too many attempts* | Wait 5 minutes. |
| Bluetooth list is empty | Device on? Within a few metres? Use Chrome or Edge, in a normal tab on `localhost`. |
| *No device chosen* | The list was closed. Tap Connect again. |
| **Safe mode** warning | The device restarted after a problem and switched sensors off. Press reset on the device once. |
| A sensor shows *missing* | Check its cable, then press reset. Temperature, SpO₂ and screen are optional. |
| *The device stopped answering* / step fails | Move closer, then **Record again**. Missing data is asked for again automatically before it fails. |
| Red **Offline** badge | Start the server (`pnpm --filter @pneumo/server start`). Same Wi-Fi for phones. |
| Page shows script errors about *Content Security Policy* | A browser extension is wrapping the page. Open it in a normal tab. |

More detail: [BLE protocol](BLE_PROTOCOL.md) · [server API](../server/PROTOCOL.md) · [server README](../server/README.md) · [implementation guide](IMPLEMENTATION_GUIDE.md)
