# Soundsible Desktop Shell

Tauri consumer wrapper for Soundsible on Windows. It uses the official native folder
dialog, supervises the bundled engine, exposes tray controls, and hands the
webview to `/player/desktop/`. It also connects to an existing station at
`/player/` without starting a local engine; see [Desktop client](../docs/DESKTOP_CLIENT.md).

## Dev workflow

The shell is built for Windows only — there is no Linux client
([why](../docs/DESKTOP_BETA.md#no-linux-app)) — so run `npm run dev` on Windows.
The configuration screen's unit and browser tests (`npm test`,
`npm run test:ui`) run anywhere.

From repo root, ensure Python deps are installed (`venv/` exists).

```bash
cd desktop-shell
npm install
export SOUNDSIBLE_REPO_ROOT="$(cd .. && pwd)"
npm run dev
```

Optional overrides:

- `SOUNDSIBLE_PYTHON` — Python binary (default: `venv/bin/python3`)
- `SOUNDSIBLE_ENGINE_BIN` — PyInstaller sidecar for packaged builds
- `SOUNDSIBLE_CONFIG_DIR` — config directory (default: platform `soundsible` config dir)

## Architecture

```
Tauri (Rust)  →  spawn soundsible_engine.py  →  poll desktop-engine-state.json
              →  health watchdog (3× fail @ 5s)  →  navigate webview to player
Tray: Open | Pair phone… | Restart engine | Stop engine | Quit
```

**Keyboard (DT5):** Global shortcuts work even when the window is hidden:

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+O` | Open / focus main window |
| `Ctrl+Alt+P` | Pair phone (QR + paired device list) |
| `Ctrl+Alt+R` | Restart engine |
| `Ctrl+Alt+S` | Stop engine (returns to shell UI) |
| `Ctrl+Alt+Q` | Quit (stops engine and exits) |

Left-click tray icon also focuses the window. Right-click opens the tray menu (platform convention).

Closing the window hides Soundsible when a usable tray is available and keeps playback running; otherwise it exits.
Use **Quit** or `Ctrl+Alt+Q` to exit and stop only the engine owned by this app. External stations keep running.

## Accessibility

- Shell buttons use 44px minimum touch targets (`DESIGN.md` DT5)
- `:focus-visible` outline on shell buttons; focus moves to the primary action when switching views (first-run → loading → error)
- The webview loads the shared responsive SolidJS player from `/player/desktop/`.

Shell source lives in `shell-ui/` and Vite writes the untracked
`shell-ui-dist/` bundle consumed by Tauri. Player UI is the existing `ui_web`
bundle served by the sidecar.

## Phone pairing (§6)

Native pairing UI in the shell (tray **Pair phone…** or `Ctrl+Alt+P`):

- Creates a pairing session via the engine API (owner token on loopback)
- Shows QR code + pairing code + claim URL
- Polls session status until the phone is paired
- Lists paired phones with revoke

Requires the engine to be running (`Ready`). The web player Settings screen still exposes the same flow for power users.

## Build

```bash
npm run build
```

PyInstaller sidecar packaging is tracked separately (eng review 4A). Dev mode runs the repo Python engine directly.

### Sidecar build (PyInstaller)

Requires a venv with `requirements.txt` installed plus `librsvg` only for icon generation (not the sidecar).

```bash
./desktop-shell/scripts/build-sidecar.sh
```

Bundle a static **FFmpeg** next to the engine (recommended for release builds):

```bash
BUNDLE_FFMPEG=1 ./desktop-shell/scripts/build-sidecar.sh
```

This runs `fetch-ffmpeg.sh`, embeds FFmpeg in the sidecar when possible, and places `binaries/ffmpeg-<target-triple>` for Tauri `externalBin`. `/api/health` reports `ffmpeg.available`.

This writes `desktop-shell/src-tauri/binaries/soundsible-engine-<target-triple>`, which Tauri bundles via `externalBin`. The shell prefers the sidecar over repo Python when present.

**Windows RC validation:** [docs/DESKTOP_BETA.md](../docs/DESKTOP_BETA.md)
**Release CI:** installers ship with the whole product on a `v*` tag — see [docs/RELEASING.md](../docs/RELEASING.md). For a build without a release, run `.github/workflows/desktop-build.yml` manually.

Sidecar flags used by the shell:

| Flag | Purpose |
|------|---------|
| `--bootstrap MUSIC_DIR` | Write consumer `config.json` before first start |
| `--music-dir MUSIC_DIR` | Runtime library path (also auto-bootstraps if config missing) |

**Returning users:** if `config.json` and `music_dir.json` already exist, the shell skips first-run and auto-starts the engine on launch.

**Start at login:** optional checkbox on first-run (uses platform autostart APIs via `tauri-plugin-autostart`).

### Smoke test

Headless check for engine health + desktop player route:

```bash
./desktop-shell/scripts/smoke-test.sh              # Python engine
./desktop-shell/scripts/smoke-test.sh --with-sidecar
```

CI runs the Python engine check in `.github/workflows/desktop-shell.yml`; the sidecar and Tauri builds, and the installed-app smokes on Windows x64 and ARM64, run in `.github/workflows/desktop-build.yml`.

**Windows sidecars:** native runners produce
`soundsible-engine-x86_64-pc-windows-msvc.exe` and
`soundsible-engine-aarch64-pc-windows-msvc.exe`. CI verifies that the shell,
engine, and FFmpeg all match the advertised architecture.

Windows RC delivery is NSIS `.exe` only. Closing the main window hides it to
the tray; **Quit** stops the engine and exits.

## Icons (DT3)

Tray and bundle icons are generated from `branding/logo-mark.svg`:

```bash
./desktop-shell/scripts/generate-icons.sh
```

Requires `rsvg-convert` (librsvg) and `@tauri-apps/cli`.

| Asset | Usage |
|-------|--------|
| `src-tauri/icons/tray-idle.png` | System tray idle glyph (32×32) |
| `src-tauri/icons/icon.{ico,icns,png}` | App bundle / window icon |

**Platform notes:**

- **Windows:** Multi-size `.ico` from bundle set.
