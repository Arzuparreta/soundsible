## CONFIGURATION – Options and environment

This document summarizes the main configuration surfaces for Soundsible.

Exact option names may evolve. When in doubt, prefer the in‑app setup wizard and settings UI.

### 1. Setup wizard (recommended)

The primary way to configure Soundsible is through the guided setup in the Station UI.

Key options:

- Library path – where your music files live.
- Storage backend – local disk, NAS, or object storage.
- Cloud backends – Cloudflare R2, Backblaze B2, generic S3 (optional).
- Downloader defaults – quality preferences and search source.

Changes made here are persisted so future sessions pick them up automatically.

### 2. Environment variables

Depending on how you deploy Soundsible, you may expose certain values via environment variables.

Typical categories:

- Paths – base paths for storage or temporary working directories.
- Feature flags and tuning – optional flags for concurrency limits or debug behaviour.
- Web player debug – append `?debug=1` to the player URL, or set `localStorage.soundsible_debug` to `1`, to enable verbose client connection/playback logs (off by default).

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
- `SOUNDSIBLE_YT_SEARCH_SOURCE` — `ytmusic` (default) or `youtube`. YouTube Music
  gives cleaner metadata but is not always reachable from a datacenter IP; set it
  to `youtube` on a VPS whose searches come back empty.

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

Long-running YouTube downloads use a robust network profile by default:

- socket timeout: `30` seconds
- HTTP chunk size: `10M`
- retry sleep: exponential backoff from 1 to 20 seconds

Override these values when required by a specific network:

```bash
export SOUNDSIBLE_YTDLP_SOCKET_TIMEOUT=45
export SOUNDSIBLE_YTDLP_HTTP_CHUNK_SIZE=4M
export SOUNDSIBLE_YTDLP_RETRY_SLEEP=linear=2:10
```

The retry expression uses yt-dlp's `--retry-sleep` syntax. These settings affect
the Station Engine's outbound YouTube transfer; the browser's LAN, Tailscale,
Funnel, or reverse-proxy connection only carries queue control and progress.
Public extraction is attempted first because it normally exposes cleaner
audio-only formats. Configured cookies are retried automatically when YouTube
requires authentication, age confirmation, or a cookie-only format.

### 3A. Web UI source-vs-build note

The SolidJS player must be built before Flask serves it (`cd ui_web && npm run build`).
For interactive development, use the Vite dev server (`npm run dev`), which proxies
the engine API and Socket.IO connection.

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
- Object storage – supported providers such as Cloudflare R2, Backblaze B2, or generic S3.

The setup wizard and settings UI handle the common cases. If you need a custom backend, look for the storage abstraction layer in the code and implement the same interface that existing backends use.

### 6. Accounts (multi-user)

One Soundsible instance serves several people. Each account gets its own
library, playlists, favourites, queue, podcast subscriptions, listening history
and preferences. The **audio files are shared**: track ids are content hashes, so
a song someone already downloaded is added to your library instantly, without a
second download or a second copy on disk.

**Nothing changes for a single-user install.** On first boot after upgrading, your
existing library is adopted by an `owner` admin account with no password, and the
engine keeps behaving exactly as before — no login screen. The originals stay on
disk renamed `*.singleuser.bak` in case you want to roll back.

**Adding the second person turns authentication on.** Settings → Account → People →
*Add someone*. You will be asked to set a password on your own account first;
otherwise adding a second library would leave the instance open to anyone on the
network. From then on everyone signs in.

| Setting | Who controls it |
|---------|-----------------|
| Library, playlists, favourites, queue, podcasts, history, theme, language | Each person, for themselves |
| Music folder, storage backend, download quality, yt-dlp cookies and auto-update, library optimization, cloud sync, accounts | Admin only |

**Adding people remotely.** Settings → Account → People → *Create invite link*
mints a single-use link valid for 7 days. Send it however you like; whoever opens
it picks their own username and password and lands straight in their (empty)
player. Nothing about the server or the other accounts is shown to them. From a
shell there is `python run.py --users invite --display-name "…" --base-url http://…`.

**Headless administration.** `python run.py --users <command>` manages accounts
without a browser: `list`, `create`, `invite`, `invites`, `passwd`, `rename`,
`role`, `disable`, `enable`, `logout`, `delete`. This is the way to set the first
password after upgrading a single-user install, and the way back in if somebody
forgets theirs.

Endpoints:

- `GET /api/auth/state` — public; tells the player whether to show a login screen.
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `POST /api/auth/password` — change your own password.
- `GET|POST /api/users`, `PATCH|DELETE /api/users/<id>`,
  `POST /api/users/<id>/password`, `DELETE /api/users/<id>/sessions` — admin only.
- `GET|POST /api/invites`, `DELETE /api/invites/<id>` — admin only.
- `GET /api/invites/<token>/preview`, `POST /api/invites/<token>/accept` — public;
  the token is the credential.

Sessions are 90-day HttpOnly cookies (`sb_session`), stored server-side as hashes
only and revocable per account from the People screen. Deleting an account removes
that person's directories; shared music files are never touched.

### 6A. Pairing and admin auth

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
