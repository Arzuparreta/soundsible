# Soundsible Desktop (Beta)

Consumer path: **Tauri shell** + **PyInstaller engine sidecar** on loopback. No terminal, no `run.py`, no manual port config for normal users.

Aligns with [Consumer Democratization plan](https://github.com/Arzuparreta/soundsible/blob/main/docs/appliance-rework-plan.md) (Approach D) and [Premium Quality Contract](./PREMIUM_QUALITY_CONTRACT.md) outcome **#1 — Setup**.

---

## What ships today (code on `main`)

| Area | Status |
|------|--------|
| First-run folder picker + live scan preview | Done (`desktop-shell/shell-ui/`) |
| Engine loading / error screens (log-forward) | Done |
| Health watchdog (3× fail @ 5s, PID kill tree) | Done |
| PyInstaller sidecar + Tauri CI (Linux + Windows) | Done |
| Phone pairing in shell (tray / `Ctrl+Alt+P`) | Done |
| Tray: Open · Pair · Restart · Stop · Quit | Done |
| Beta banner after first play (webview) | Done |
| Setup telemetry (`setup_first_play`, rollup script) | Done |
| FFmpeg resolution (`shared/ffmpeg_runtime.py`) | Done — bundle via `BUNDLE_FFMPEG=1` at build time |

| Area | Not done yet (beta blockers) |
|------|------------------------------|
| Friend-ready **GitHub Release** installers | In progress — see [Release builds](#release-builds) |
| Clean VM proof (≤10 min to first play) | **Gate A1** — run checklist below |
| Phase 0 HDD soak (30 min) | **Gate B1** — maintainer machine |
| v1.1 Tailscale 30 min walk | After 1a green |
| Auto-update, macOS notarization, VU tray animation | Explicitly deferred |

Visual spec: `DESIGN.md` and the design consultation preview under your gstack project folder.

---

## Release builds

Tagged releases and manual workflow runs produce installers:

- Workflow: `.github/workflows/desktop-release.yml`
- Tag pattern: `desktop-v*` (example: `desktop-v0.1.0-beta.1`)

**Maintainer build (local):**

```bash
cd desktop-shell
export SOUNDSIBLE_REPO_ROOT="$(cd .. && pwd)"
BUNDLE_FFMPEG=1 ../desktop-shell/scripts/build-sidecar.sh
npm ci && npm run build
```

Artifacts land under `desktop-shell/src-tauri/target/release/bundle/` (`.deb`, `.AppImage`, `.msi`, etc., depending on OS).

---

## Gate A1 — Clean VM smoke (≤10 minutes)

Run on a **fresh** VM with **no** Python, git, or FFmpeg on `PATH`. Use only the release artifact (or CI build output).

### Linux (reference)

1. Install `.deb` or run `.AppImage` from the release.
2. Launch **Soundsible (Beta)**.
3. **Choose folder…** → pick a directory with at least one playable audio file (`.mp3`, `.flac`, …).
4. Confirm scan preview appears (track count / size).
5. **Continue** → wait for engine log → webview opens.
6. Play one track from Library; confirm audio.
7. Close window → tray remains → **Open** from tray → player still works.
8. **Quit** from tray → app exits.

| Step | Pass | Notes |
|------|------|-------|
| 1–2 Launch | ☐ | |
| 3 Folder picker | ☐ | Native dialog, not path text field |
| 4 Scan preview | ☐ | |
| 5 Engine start | ☐ | No blank window >30s |
| 6 First play | ☐ | Record elapsed time from launch: _____ min |
| 7 Tray persist | ☐ | |
| 8 Clean quit | ☐ | No orphan `soundsible-engine` in `ps` |

**Pass:** steps 1–8 OK and step 6 ≤ **10 minutes**.

### Windows (reference)

Same flow with `.msi` / NSIS installer from release. Note OS build and antivirus interactions.

### Health check (optional)

While engine is running:

```bash
curl -s http://127.0.0.1:<port>/api/health | jq '.ffmpeg'
```

Expect `"available": true` when built with `BUNDLE_FFMPEG=1`.

---

## Gate B1 — Phase 0 HDD soak (maintainer)

On the **reference HDD laptop** (5400 RPM, 8GB RAM):

1. Start desktop app with a large library folder.
2. Trigger **library scan** + **2 YouTube downloads** while browsing Library/Discover.
3. Run **30 minutes** without manually restarting the engine.
4. Sample `/api/health` latency during scan (target p95 **<2s**).
5. After a heavy write burst, playback should resume within **~3s**.

Log results in the issue tracker or a dated note in `docs/DESKTOP_BETA.md` (changelog section below).

---

## Setup gate rollup (after friend tests)

Telemetry file (default): `<data_dir>/telemetry/setup-events.jsonl`

```bash
python scripts/setup_gate_rollup.py --events /path/to/setup-events.jsonl
```

Target from Premium Contract: **≥95%** of sessions reach `setup_first_play` within **10 minutes** (rolling 7 days).

---

## Dev workflow (contributors)

See [desktop-shell/README.md](../desktop-shell/README.md).

```bash
cd desktop-shell && npm install
export SOUNDSIBLE_REPO_ROOT="$(cd .. && pwd)"
npm run dev
```

Headless engine smoke:

```bash
./desktop-shell/scripts/smoke-test.sh --with-sidecar
```

---

## Changelog (beta validation log)

| Date | Tester | OS | Result | Notes |
|------|--------|-----|--------|-------|
| | | | | |

---

## What comes next (order)

1. **A1** — Clean VM smoke on Linux + Windows release artifacts  
2. **A3** — Publish `desktop-v0.1.0-beta.1` (or similar) on GitHub Releases  
3. **A4** — Friend installs + `setup_gate_rollup.py`  
4. **B1** — HDD soak on your machine  
5. **C1** — Tailscale 30 min walk (v1.1)  
6. Premium Phase 1 migration gate hardening (after consumer baseline)
