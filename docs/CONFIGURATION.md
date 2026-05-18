## CONFIGURATION – Options and environment

This document summarizes the main configuration surfaces for Soundsible.

Exact option names may evolve. When in doubt, prefer the in‑app setup wizard and settings UI.

### 1. Setup wizard (recommended)

The primary way to configure Soundsible is through the guided setup in the Station UI.

Key options:

- Library path – where your music files live.
- Storage backend – local disk, NAS, or object storage.
- Cloud backends – Cloudflare R2, Backblaze B2/R2, S2 (optional).
- Downloader defaults – quality preferences and search source.

Changes made here are persisted so future sessions pick them up automatically.

### 2. Environment variables

Depending on how you deploy Soundsible, you may expose certain values via environment variables.

Typical categories:

- Paths – base paths for storage or temporary working directories.
- Feature flags and tuning – optional flags for concurrency limits or debug behaviour.

Consult the code and any sample `.env` files in the repository for the current list of supported variables.

### 2A. Runtime and path variables

The current runtime layer supports these top-level environment variables:

- `SOUNDSIBLE_HOST`
- `SOUNDSIBLE_PORT`
- `SOUNDSIBLE_CONFIG_DIR`
- `SOUNDSIBLE_DATA_DIR`
- `SOUNDSIBLE_CACHE_DIR`
- `SOUNDSIBLE_LOG_DIR`
- `SOUNDSIBLE_MUSIC_DIR`
- `SOUNDSIBLE_UI_DIST`
- `SOUNDSIBLE_OWNER_TOKEN_FILE`
- `SOUNDSIBLE_LAN_ENABLED`
- `SOUNDSIBLE_ADVANCED_MODE`

Notes:

- `python3 run.py --daemon` still defaults to the legacy server-style path (`0.0.0.0:5005` unless overridden).
- `python3 run.py --desktop-engine` defaults to `127.0.0.1` and a random free port.
- Platform app directories are resolved through `platformdirs`, and legacy `~/.config/soundsible`, `~/.cache/soundsible`, and `~/.local/share/soundsible` are migrated/read automatically.

### 2B. Desktop runtime token files

Desktop-engine mode creates and uses:

- `desktop-owner-token` in the Soundsible config directory by default
- `desktop-engine-state.json` in the Soundsible config directory

`desktop-owner-token` is the current owner credential for the local desktop UI and appliance shell work. `desktop-engine-state.json` records the owned process/runtime details so a future shell can stop the correct PID without killing by port.

### 3. Downloader / ODST settings

The ODST downloader can be tuned from configuration and the UI.

Main controls:

- Selecting the search and download source (YouTube vs YouTube Music).
- Choosing quality presets (lossless by default where available, with manual selection).
- Controlling parallelism and concurrency for faster downloads (subject to your bandwidth and hardware).

Refer to `odst_tool/README.md` for more details on standalone ODST usage.

If downloads fail with yt‑dlp “Requested format is not available” when using cookies, see [troubleshooting-yt-dlp-formats.md](troubleshooting-yt-dlp-formats.md).

For VPS or datacenter deployments, YouTube may require authenticated cookies. Place an exported YouTube cookies file at:

```bash
~/.config/soundsible/cookies.txt
```

Or point Soundsible at it explicitly:

```bash
export SOUNDSIBLE_YTDLP_COOKIE_FILE=/path/to/cookies.txt
```

Soundsible forces yt-dlp over IPv4 by default because some VPS IPv6 routes hang during YouTube extraction. To disable that:

```bash
export SOUNDSIBLE_YTDLP_FORCE_IPV4=false
```

### 3A. Web UI source-vs-build note

When Flask serves the source UI directly from `ui_web/`, browser-safe vendor files must exist in `ui_web/js/vendor/`.

That currently includes:

- `socket.io-client.esm.min.js`
- `qrcode.esm.js`

`npm install` and `npm run build` refresh those vendor files automatically through:

- `ui_web/scripts/sync-vendor-socket.mjs`
- `ui_web/scripts/sync-vendor-qrcode.mjs`

### 4. Discover (Deezer metadata)

- **No Deezer API key** is required for the built-in Discover experience. The Station proxies **public** Deezer GET endpoints (see [ARCHITECTURE.md](ARCHITECTURE.md)).
- The engine must be able to reach **`https://api.deezer.com`** outbound. If that fails, Discover lists and search will be empty or error.
- Playback still depends on **YouTube / YouTube Music search** (ODST) and your existing downloader configuration; Discover does not add a separate audio backend.

### 5. Storage configuration overview

At a high level, storage can be configured in three ways:

- Local disk – default mode; files stored on the same machine running Soundsible.
- NAS or shared storage – a mounted network path used as the library location.
- Object storage – supported providers such as Cloudflare R2, Backblaze B2/R2, or S2.

The setup wizard and settings UI handle the common cases. If you need a custom backend, look for the storage abstraction layer in the code and implement the same interface that existing backends use.

### 6. Pairing and admin auth

Current pairing/runtime auth surfaces:

- Agent tokens: `POST /api/agent/token`
- Paired-device tokens: created by the pairing session flow
- Owner token: desktop-engine local owner credential

Current pairing endpoints:

- `GET/POST /api/pairing/sessions`
- `POST /api/pairing/sessions/claim`
- `POST /api/pairing/sessions/<id>/confirm`
- `POST /api/pairing/sessions/<id>/cancel`
- `POST /api/pairing/sessions/<id>/display-open`
- `POST /api/pairing/sessions/<id>/display-close`
- `GET /api/paired-devices`
- `POST /api/paired-devices/<token_id>/revoke`

The desktop player pairing modal now consumes this flow directly and renders a QR code from the backend `qr_text` payload.
