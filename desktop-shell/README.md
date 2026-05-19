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
```

Shell UI lives in `shell-ui/` (DESIGN.md tokens). Player UI is the existing `ui_web` bundle served by the sidecar.

## Build

```bash
npm run build
```

PyInstaller sidecar packaging is tracked separately (eng review 4A). Dev mode runs the repo Python engine directly.
