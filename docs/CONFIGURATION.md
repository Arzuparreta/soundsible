# Configuration

Most of Soundsible is configured in the player: open **Settings**, or search
for a setting from the box at its top. What the player cannot change — where
the engine listens, where it keeps its files, how it reaches YouTube — comes
from environment variables. This page covers both.

## 1. Setup and Settings

### Setup page

A source install asks a few questions once, on the setup page at
`http://localhost:5099/setup` (see [First run](INSTALL.md#first-run)):

- **Where your music is** — a folder on this computer, which can be a NAS or
  Samba share the computer mounts, or a Cloudflare R2 or Backblaze B2 bucket.
- **The folder or account** to use, and for cloud storage, the bucket.
- **Optional settings** — download quality and where temporary copies are
  cached.

Setup writes `config.json` to the
[configuration directory](#7-where-soundsible-keeps-its-files). Reopen it with
`python3 run.py --setup`. Docker and the desktop app skip this page: the
container configures `/music` on its first boot, and the desktop app asks for a
music folder on its own first-run screen.

### Settings

Everything else lives in **Settings** in the player: theme, language, playback,
downloads and lossless upgrades, library rescans, accounts, paired devices and
music import. Some settings belong to each person and some only to an admin;
[Accounts](#6-accounts-multi-user) lists which.

### Navigation preferences

The mobile bottom bar starts with **Library, Search, Favourites, Settings**.
Open **Settings → Appearance → Bottom bar** to choose between three and five
sections and set their order. Selecting a section already assigned to another
position swaps the two. Changes apply immediately and are saved in this browser
or installation; **Restore defaults** returns the original four buttons.

The header's menu opens the complete navigation, including Playlists, Podcasts,
Live, Downloads and the Songs, Albums and Artists library views. Settings remains
accessible there even if you remove it from the bottom bar. Desktop uses the same
complete navigation in its persistent sidebar; customizing the bottom bar does
not rearrange that sidebar.


## 2. Environment variables

Set them where the engine starts, then restart it — they are read at start:

| You run Soundsible with | Put variables in |
| --- | --- |
| `python3 run.py` or `python3 run.py --daemon` | The shell that starts it: `export NAME=value` first, or `NAME=value python3 run.py --daemon`. |
| systemd | A drop-in: `sudo systemctl edit soundsible`, then `Environment=NAME=value` under `[Service]`. See [the service guide](INSTALL.md#run-it-as-a-systemd-service). |
| Docker Compose | The `.env` file beside `compose.yaml`, or the `environment:` section. See [Docker](DOCKER.md#configuration-and-security). |

### Network and access

| Variable | Default | Effect |
| --- | --- | --- |
| `SOUNDSIBLE_HOST` | `0.0.0.0` | Address the engine listens on; same as `--host`. The desktop app uses `127.0.0.1`. |
| `SOUNDSIBLE_PORT` | `5005` | Port the engine listens on; same as `--port`. The terminal menu always uses 5005. |
| `SOUNDSIBLE_ADMIN_TOKEN` | unset | When set, admin routes require it as `Authorization: Bearer <token>` or `X-Soundsible-Admin-Token: <token>`. See the [security baseline](INSTALL.md#8-security-baseline). |
| `SOUNDSIBLE_ALLOWED_ORIGINS` | localhost, private LAN and Tailscale addresses | Comma-separated browser origins allowed to call the API. |
| `SOUNDSIBLE_SOCKET_CORS_ORIGINS` | any | Comma-separated origins allowed to open the real-time connection. |
| `SOUNDSIBLE_HTTPS_URL` | unset | Your own HTTPS address, so [Live](LIVE.md#5-broadcasting-needs-https) can send a browser there to broadcast. |
| `SOUNDSIBLE_LAUNCHER_BIND_ALL` | `false` | `true` makes the setup page and launcher answer on the network, not only on `localhost`. |
| `LAUNCHER_PORT` | `5099` | Port of the setup page and launcher. |
| `SOUNDSIBLE_LAN_ENABLED` | on, unless the host is loopback | Whether browsers on other machines are expected; same as `--lan-enabled` / `--no-lan`. |
| `SOUNDSIBLE_ADVANCED_MODE` | on for `--daemon`, off for the desktop app | While the instance has one account and no password, trust browsers on the LAN and tailnet as its owner. It has no effect once sign-in is required. |

### Paths

Each has a matching `run.py` option (`--config-dir`, `--data-dir`, …). The
defaults are listed in [section 7](#7-where-soundsible-keeps-its-files).

| Variable | Holds |
| --- | --- |
| `SOUNDSIBLE_CONFIG_DIR` | `config.json`, the instance database with its accounts, and each person's library, playlists and favourites. Back this up. |
| `SOUNDSIBLE_DATA_DIR` | Queues, import jobs, listening telemetry and preserved artwork. |
| `SOUNDSIBLE_CACHE_DIR` | Covers, preview audio and DJ analysis. Everything here is rebuildable. When Soundsible moves from the legacy `~/.cache/soundsible` to a platform cache directory it carries covers and DJ analysis across but **not** `previews/` or `media/`: those are bulk audio that re-downloads on demand. |
| `SOUNDSIBLE_LOG_LEVEL` | Console logging level for native and container engines; defaults to `INFO`. DJ planning reports cache hits, pending fetches and route outcomes here. |
| `SOUNDSIBLE_LOG_DIR` | The log directory the engine reports in `/api/health`. The engine itself logs to its terminal — the journal under systemd, `docker compose logs` in Docker. |
| `SOUNDSIBLE_MUSIC_DIR` | The music folder, when it is not the one chosen during setup. |
| `SOUNDSIBLE_UI_DIST` | A prebuilt web player to serve instead of `ui_web/dist`. The container and the desktop app set it; a source install does not need it. |
| `SOUNDSIBLE_OWNER_TOKEN_FILE` | Where the desktop app's owner token is written. |

### YouTube and downloads

| Variable | Default | Effect |
| --- | --- | --- |
| `SOUNDSIBLE_YT_SEARCH_SOURCE` | `ytmusic` | `ytmusic` or `youtube`. YouTube Music gives cleaner metadata but is not always reachable from a datacenter IP; set `youtube` on a VPS whose searches come back empty. |
| `SOUNDSIBLE_YT_PROXY` | unset | Private HTTP relay used for both YouTube resolution and the resulting media transfer. For the supported VPS topology use Soundsible's Tailscale-only relay; see [VPS_RELAY.md](VPS_RELAY.md). |
| `SOUNDSIBLE_YTDLP_COOKIE_FILE` | `cookies.txt` in the configuration directory | YouTube cookies file; see [YouTube cookies](#youtube-cookies). |
| `SOUNDSIBLE_YTDLP_FORCE_IPV4` | `true` | Forces yt-dlp over IPv4, because some VPS IPv6 routes hang during YouTube extraction. |
| `SOUNDSIBLE_YTDLP_SOCKET_TIMEOUT` | `30` | yt-dlp socket timeout, in seconds. |
| `SOUNDSIBLE_YTDLP_HTTP_CHUNK_SIZE` | `10M` | yt-dlp HTTP chunk size. |
| `SOUNDSIBLE_YTDLP_RETRY_SLEEP` | exponential, 1 to 20 s | yt-dlp `--retry-sleep` expression, e.g. `linear=2:10`. |
| `SOUNDSIBLE_PREVIEW_CACHE_MB` | `2048` | Disk (not RAM) for the preview-audio LRU cache. `0` disables audio caching while URL warming remains available. |
| `SOUNDSIBLE_LOSSLESS_UPGRADES` | `true` | Background lossless upgrades; also switchable in Settings. |
| `SOUNDSIBLE_FFMPEG` | FFmpeg on `PATH` | Explicit path to the FFmpeg binary. |

### Features

| Variable | Default | Effect |
| --- | --- | --- |
| `SOUNDSIBLE_COMMUNITY_DISABLED` | `false` | `true` turns Live off. |
| `SOUNDSIBLE_COMMUNITY_URL` | Soundsible's official service | Bare HTTPS origin of your own Live relay — no credentials, path, query or fragment. The self-hosted stack is documented in [deploy/community/README.md](../deploy/community/README.md). |
| `SOUNDSIBLE_TELEMETRY_ENABLED` | on | `0`, `false` or `off` stops recording local listening telemetry. See [Privacy](TELEMETRY_PRIVACY.md). |
| `SOUNDSIBLE_LOUDNESS_ANALYSIS` | on | `false` stops measuring new tracks for loudness levelling; tracks already measured keep their levels. |
| `SOUNDSIBLE_SUBSONIC_MAX_TRANSCODES` | `2` | Concurrent [OpenSubsonic](OPENSUBSONIC.md) transcodes. |
| `SOUNDSIBLE_SKIP_UI_BUILD` | unset | `1` stops the engine rebuilding the web player on start; it serves whatever `ui_web/dist` holds. |

To turn on verbose connection and playback logs in one browser, append
`?debug=1` to the player URL, or set `localStorage.soundsible_debug` to `1`.

A source install never needs a manual build of the web player: the engine
rebuilds it from `ui_web/` whenever the sources change. For frontend
development, see [ui_web/README.md](../ui_web/README.md).

## 3. Downloads

Choose the download quality in **Settings → Downloads**; it applies to new
downloads. The search source is the `SOUNDSIBLE_YT_SEARCH_SOURCE`
[variable](#youtube-and-downloads).

### Optional lossless sources

The lossless upgrader works without credentials through Wikimedia Commons and
Internet Archive. Jamendo coverage is enabled with the read-only `client_id`
assigned to a registered application at
[`devportal.jamendo.com`](https://devportal.jamendo.com/).

An instance administrator can enter that value in **Settings → Downloads →
Lossless upgrades → Jamendo Client ID**. Soundsible validates it with Jamendo
before storing it in the ignored `odst_tool/.env` file, never returns the value
through the status API, and reloads the provider without a daemon restart.
OAuth `client_secret` and access tokens are not needed and must not be entered.

### YouTube cookies

For VPS or datacenter deployments, YouTube may require authenticated cookies.
Export a YouTube cookies file and place it as `cookies.txt` in the
[configuration directory](#7-where-soundsible-keeps-its-files) — on Linux,
`~/.config/soundsible/cookies.txt` — or point Soundsible at it explicitly:

```bash
export SOUNDSIBLE_YTDLP_COOKIE_FILE=/path/to/cookies.txt
```

Public extraction is attempted first because it normally exposes cleaner
audio-only formats. Configured cookies are retried automatically when YouTube
requires authentication, age confirmation, or a cookie-only format. See
[download troubleshooting](troubleshooting-yt-dlp-formats.md) if downloads still
fail.

### Network behaviour

Long-running YouTube downloads use a robust network profile by default — the
socket timeout, chunk size and retry sleep in the
[table above](#youtube-and-downloads). These settings affect the Station
Engine's outbound YouTube transfer; the browser's LAN, Tailscale, Funnel, or
reverse-proxy connection only carries queue control and progress.

When a relay is configured, every resolved stream records whether it came from
direct or relay egress. Preview streaming and prefetch reuse that exact path;
they never guess from the current environment after the URL has been resolved.

The standalone downloader in `odst_tool/` is documented in
[odst_tool/README.md](../odst_tool/README.md).

## 4. Discover (Deezer metadata)

- **No Deezer API key** is required for the built-in Discover experience. The Station proxies **public** Deezer GET endpoints (see [ARCHITECTURE.md](ARCHITECTURE.md)).
- The engine must be able to reach **`https://api.deezer.com`** outbound. If that fails, Discover lists and search will be empty or error.
- Playback still depends on **YouTube / YouTube Music search** (ODST) and your existing downloader configuration; Discover does not add a separate audio backend.

## 5. Storage

Storage is chosen during [setup](#setup-page):

- **Local disk** — the default; files are stored on the machine running
  Soundsible.
- **NAS or shared storage** — a network path the machine mounts, used as the
  library folder. Under systemd, make the service
  [wait for the mount](INSTALL.md#7-storage).
- **Object storage** — Cloudflare R2 or Backblaze B2. Other S3-compatible
  services are not implemented.

## 6. Accounts (multi-user)

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
| Library, playlists, favourites, queue, podcasts, history, theme, language | Each person, for themselves. On the desktop app the theme is also handed to the app's own first-run, loading and error screens, so the whole window matches |
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

### Pairing and admin auth

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

## 7. Where Soundsible keeps its files

A source install and the desktop app resolve their directories per platform.
The container uses `/config`, `/data`, `/cache`, `/logs` and `/music` instead.

| | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Configuration | `~/.config/soundsible` | `~/Library/Application Support/soundsible` | `%LOCALAPPDATA%\soundsible` |
| Data | `~/.local/share/soundsible` | `~/Library/Application Support/soundsible` | `%LOCALAPPDATA%\soundsible` |
| Cache | `~/.cache/soundsible` | `~/Library/Caches/soundsible` | `%LOCALAPPDATA%\soundsible\Cache` |
| Music (default) | `~/Music/Soundsible` | `~/Music/Soundsible` | `%USERPROFILE%\Music\Soundsible` |

They belong to the user who runs the engine, which is why a
[systemd service](INSTALL.md#run-it-as-a-systemd-service) should run as the
user who completed setup. Older installs used `~/.config/soundsible`,
`~/.cache/soundsible` and `~/.local/share/soundsible` on every platform; those
are copied to the new locations on first start. The `run.py` options and
[path variables](#paths) override any of them.

The desktop app also keeps two files in the configuration directory:

- `desktop-owner-token` — the owner credential for the local desktop UI.
- `desktop-engine-state.json` — the running engine's process and address, so
  the app stops the right process instead of killing by port.
