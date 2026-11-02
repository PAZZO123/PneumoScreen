# @pneumo/server: local records server (demo phase)

This runs on a laptop on the clinic network. It does four things:
- keeps every baby's screening records;
- receives offline sync from the phones;
- relays live screenings to the dashboard;
- serves analytics.

It uses Node 24's built-in SQLite and TypeScript support, so there's no build step. The protocol is in [PROTOCOL.md](PROTOCOL.md).

## Run

```bash
pnpm install
pnpm --filter @pneumo/server seed     # demo accounts; passwords go to server/.env.local
pnpm --filter @pneumo/server start    # http://localhost:8787 (it also prints the LAN address)
```

Open the printed address for the dashboard, and sign in with an account from `server/.env.local`.

Data lives in `server/data/` (SQLite plus WAV recordings). Both `server/data/` and `.env.local` are git-ignored.

| Env | Default | |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | |
| `PNEUMO_DATA_DIR` | `server/data` | |
| `PNEUMO_CORS_ORIGINS` | Capacitor + localhost dev origins | comma-separated |

## Test

```bash
pnpm --filter @pneumo/server test
pnpm --filter @pneumo/server typecheck
```

## Demo limits (before the cloud phase)

- HTTP on the LAN, not HTTPS. Anyone on the same Wi-Fi can see the traffic, so use a private network. The phone apps need the cleartext/ATS exception for this host.
- One SQLite file and no backups; copy `server/data/` to back it up.
- Live events are relayed but not stored; the records themselves arrive through sync.
