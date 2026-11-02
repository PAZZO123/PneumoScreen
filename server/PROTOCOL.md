# PneumoScreen server protocol (v1)

This is what the phone app speaks to the local server. Types live in `server/src/wire.ts` (`import type … from '@pneumo/server/wire'`). All times are ISO-8601 UTC. IDs are UUIDs **generated on the phone**, so records can be created offline.

## Auth

`POST /api/login {username, password}` returns `{token, worker, expires_at}`. Tokens last 12 h.

- REST: `Authorization: Bearer <token>`.
- WebSockets: the **first message** is `{type:"auth", token, …}`. Tokens never go in URLs.
- After 10 wrong passwords for one username, login returns `429` for 5 minutes.

Roles:
- `worker` sees babies they created or are `assigned_to`, and everything under those babies.
- `supervisor` sees everything.

A record you can't see answers `404`, as if it didn't exist. Writing to one returns `403` / `error: "forbidden"`.

## Records

| Table | Notes |
|---|---|
| `babies` | `name`, `date_of_birth` (YYYY-MM-DD), `sex` (`female` `male` `other` `unknown`), `guardian_name`, `guardian_phone`, `village`, `notes`, `assigned_to` (worker id). `created_by` is set by the server. |
| `sessions` | `baby_id`, `started_at`, `finished_at`, `device_id`, `firmware_version`, `result` (`{refer, reasons[], rules_version, …}`). The server sets `worker_id` and **derives `status`**: `complete` when every required step is `done`, otherwise `incomplete`. |
| `steps` | `session_id`, `type` (`breath` `lung_RU` `lung_LU` `lung_RL` `lung_LL` `temp` `spo2`), `required`, `status` (`pending` `done` `missing` `poor`), `accepted_attempt`. One step per type per session. |
| `attempts` | `step_id`, `n` (1, 2, … per re-record), `values`, `quality`, `model_output`, `recording_id`, `created_at`. **Append-only**: never updated. |

Every row in `babies`, `sessions` and `steps` has `updated_at` and `deleted`. Deleting is a soft delete: send `deleted: true` with a newer `updated_at`.

Conventions for `attempts.values` (the analytics read these):

| Step | values |
|---|---|
| `breath` | `{bpm, quality}` |
| `lung_*` | `{class: normal\|crackles\|wheezes\|noise, probs: [4], windows}` |
| `temp` | `{celsius, humidity}` (ambient sensor) |
| `spo2` | `{spo2, hr}` |

### Conflict rule

- `babies`, `sessions`, `steps`: **last write wins on `updated_at`**. An incoming row with the same or an older `updated_at` is ignored (`stale`) and the stored row is kept.
- `attempts`: a known id is ignored (`duplicate`). Values never change.

Each applied change gets a global, increasing `rev`.

## `/ws/sync`

```
→ {type:"auth", token}
← {type:"auth_ok", worker}

→ {type:"push", batch_id, changes:[{table, record}, …]}    ≤ 500 per batch
← {type:"ack", batch_id, results:[{table, id, status, rev?, error?}, …]}

→ {type:"pull", since: <cursor>, limit?: 1..2000 (default 500)}
← {type:"changes", changes:[{table, record}], cursor, more}

← {type:"poke", rev}     another device changed something: pull again
← {type:"error", error}
```

- `status` is one of:
  - `applied`: stored; drop it from the outbox.
  - `stale` or `duplicate`: the server already has this or newer; drop it, and pull to get the server copy.
  - `rejected`: invalid. `error` says why. **`missing_parent: …`** means push the parent first, then retry; anything else is a bug to surface, not retry forever.
- Changes in a batch apply in order, so push parents first: baby, then session, then steps, then attempts.
- `pull` returns your visible records with `rev > since`, in `rev` order. Keep `cursor` and call again while `more` is true. Start at `since: 0`.
- Pulled records include the server-derived fields (`status`, `worker_id`, `created_by`, `rev`).

## REST (same rules as sync)

| Method | Path | |
|---|---|---|
| GET | `/api/health` | no auth |
| POST | `/api/login`, `/api/logout` | |
| GET | `/api/me` | |
| GET | `/api/workers` | supervisor; for `assigned_to` |
| POST | `/api/babies/search` `{q?, limit?}` | a POST so names stay out of URLs and logs |
| GET | `/api/babies/:id`, `/api/babies/:id/sessions` | |
| PUT | `/api/babies/:id`, `/api/sessions/:id`, `/api/steps/:id` | body = record, returns an apply result |
| POST | `/api/attempts` | body = attempt |
| GET | `/api/sessions/:id` | `{session, steps, attempts}` |
| GET | `/api/analytics/baby/:id` | visits, trends, lung grid |
| GET | `/api/analytics/overview?from=YYYY-MM-DD&to=YYYY-MM-DD` | totals, per day, per worker, follow-up list, devices |

## Recordings (resumable)

Audio is uploaded as raw **int16 LE PCM** (the board's 4 kHz audio, `StepData.audio`) and stored as WAV. The upload uses the same UUID as `attempts.recording_id`. The attempt may sync before the audio finishes uploading.

```
HEAD /api/recordings/:id            → x-received-bytes, x-total-bytes, x-state (partial|complete); 404 if new
PUT  /api/recordings/:id?offset=N   content-type: application/octet-stream
     x-total-bytes: <all bytes>  x-sample-rate: 4000  x-sha256: <hex of all PCM bytes>
     → {state, received, total}
GET  /api/recordings/:id            → audio/wav once complete
```

- Send chunks of up to 1 MB in order. Each response, and `HEAD`, says how far the server got.
- `409` means wrong offset: resume from `x-received-bytes`.
- On the last chunk the server checks SHA-256. A mismatch returns `422` and restarts at offset 0.
- Only the uploader writes. Readers are the uploader, supervisors, and anyone who can see an attempt that uses the recording.

## `/ws/session/:id` (live view)

```
→ {type:"auth", token, role:"publisher"|"watcher"}
← {type:"auth_ok", watchers}
← {type:"presence", publishers, watchers}           on every join/leave
→ {type:"event", event:{kind, step?, …}}            publishers only
← {type:"event", session_id, event, at, from}       to watchers
```

- `kind` is one of `step_started`, `progress`, `level`, `step_done`, `step_failed`, `result`, `device`.
- The session must already be synced, and visible to you; otherwise the server closes the socket with `4404`.
- Live events are not stored. The records arrive through sync.
- The socket closes with `4401` if the first message isn't a valid `auth` within 5 s.
