# Soundsible Desktop Shell

Tauri consumer wrapper for Soundsible (T4/T6). First-run folder picker, engine supervisor, tray menu, webview handoff to `/player/desktop/`.

## Dev workflow

**Linux deps (once):** `webkit2gtk-4.1`, `gtk3`, `libappindicator-gtk3`, `librsvg`, `base-devel`  
Arch: `sudo pacman -S webkit2gtk-4.1 gtk3 libappindicator-gtk3 librsvg base-devel`

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
Tray: Open | Restart engine | Quit

**Keyboard (DT5):** Global shortcuts work even when the window is hidden:

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+O` | Open / focus main window |
| `Ctrl+Alt+R` | Restart engine |
| `Ctrl+Alt+Q` | Quit |

Left-click tray icon also focuses the window. Right-click opens the tray menu (platform convention).

## Accessibility

- Shell buttons use 44px minimum touch targets (`DESIGN.md` DT5)
- `:focus-visible` outline on shell buttons; focus moves to the primary action when switching views (first-run → loading → error)
- Webview beta banner dismiss button is 44×44px (`ui_web/css/_desktop_custom.css`)
```

Shell UI lives in `shell-ui/` (DESIGN.md tokens). Player UI is the existing `ui_web` bundle served by the sidecar.

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

This writes `desktop-shell/src-tauri/binaries/soundsible-engine-<target-triple>`, which Tauri bundles via `externalBin`. The shell prefers the sidecar over repo Python when present.

Sidecar flags used by the shell:

| Flag | Purpose |
|------|---------|
| `--bootstrap MUSIC_DIR` | Write consumer `config.json` before first start |
| `--music-dir MUSIC_DIR` | Runtime library path (also auto-bootstraps if config missing) |

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

- **Linux:** Colored static glyph in AppIndicator tray (VU-meter animation deferred).
- **Windows:** Multi-size `.ico` from bundle set.
- **macOS:** Colored glyph for v1; template (monochrome menu-bar) icon deferred until VU-meter tray work.
