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
| **Published** GitHub Release (draft → public) | CI built artifacts — owner publishes draft or downloads from Actions |
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
- **Current release:** [desktop-v0.1.0-beta.1](https://github.com/Arzuparreta/soundsible/releases/tag/desktop-v0.1.0-beta.1) (prerelease) — **⚠️ outdated** (36 commits behind `main` at time of release; missing beta.2–beta.8 fixes such as Windows folder picker, CI ruff, logging refactor, etc.)
- **Latest tag:** `desktop-v0.1.0-beta.8` (no release assets yet — needs to be published)

Linux CI builds **`.deb` only** after workflow tuning (AppImage is slow/hang-prone on runners). Full local builds can still produce AppImage via `npm run build`.
- **First beta build (2026-05-19):** [Actions run #1](https://github.com/Arzuparreta/soundsible/actions/runs/26096184389) — **success** (~31 min). Workflow artifacts:
  - `soundsible-desktop-linux-desktop-v0.1.0-beta.1` (~729 MB)
  - `soundsible-desktop-windows-desktop-v0.1.0-beta.1` (~382 MB)
- **Draft release:** `desktop-v0.1.0-beta.1` (publish from https://github.com/Arzuparreta/soundsible/releases — **Drafts**). Bundled assets:
  - Linux: `Soundsible.Beta._0.1.0_amd64.deb`, `.AppImage`, `.rpm`
  - Windows: `Soundsible.Beta._0.1.0_x64-setup.exe`, `Soundsible.Beta._0.1.0_x64_en-US.msi`
- Workflow zip artifacts (same build): `soundsible-desktop-linux-desktop-v0.1.0-beta.1`, `soundsible-desktop-windows-desktop-v0.1.0-beta.1`

**Maintainer build (local):**

```bash
./desktop-shell/scripts/desktop-beta-build.sh
```

Or step by step:

```bash
export SOUNDSIBLE_REPO_ROOT="$(cd "$(git rev-parse --show-toplevel)" && pwd)"
BUNDLE_FFMPEG=1 "$SOUNDSIBLE_REPO_ROOT/desktop-shell/scripts/build-sidecar.sh"
cd desktop-shell && npm ci && npm run build
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

### Gate A1 — Partial results (2026-06-06, dev machine)

> **Note:** This is a partial validation on the current dev machine (Arch Linux, headless). A full VM run is still required for sign-off.

**What was validated (engine sidecar, headless):**

| Step | Pass | Notes |
|------|------|-------|
| 5 Engine start | ✅ | Sidecar emits readiness JSON, `/api/health` returns `healthy`, FFmpeg `available: true` (bundle), `/player/desktop/` 200 OK |
| 8 Clean quit | ✅ | `kill <pid>` stops engine cleanly; no orphan `soundsible-engine` in `ps` |

**What is blocked (Tauri UI):**

| Step | Pass | Notes |
|------|------|-------|
| 1–2 Launch | ☐ | AppImage requires display (GTK init); blocked by headless env |
| 3 Folder picker | ☐ | Needs Tauri window + dialog plugin |
| 4 Scan preview | ☐ | Needs Tauri first-run UI |
| 6 First play | ☐ | Needs webview + audio output |
| 7 Tray persist | ☐ | Needs tray/menu-bar + display |

**Next step:** Run the `.AppImage` on a **clean Linux VM with a display** (GNOME/KDE/XFCE) to complete steps 1–4, 6–7. Record elapsed time for step 6.

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
| 2026-05-19 | GitHub Actions | linux+windows | CI pass | Tag `desktop-v0.1.0-beta.1`, [run 26096184389](https://github.com/Arzuparreta/soundsible/actions/runs/26096184389); artifacts uploaded |
| | | | | Gate A1 VM pending |
| 2026-06-06 | Dev machine (Arch) | linux | Partial pass | Engine sidecar smoke OK (readiness + health + FFmpeg). Tauri UI blocked: no display (GTK init fails). Gate A1 VM run still needed. |

---

## What comes next (order)

1. **A1** — Complete VM smoke on a clean Linux VM with display (GNOME/KDE). Steps 5 + 8 validated headless; steps 1–4, 6–7 need GUI.  
2. **A3** — Publish draft release on GitHub (latest tag should be `desktop-v0.1.0-beta.8` or newer, not `beta.1`).  
3. **A4** — Friend installs + `setup_gate_rollup.py`  
4. **B1** — HDD soak on your machine  
5. **C1** — Tailscale 30 min walk (v1.1)  
6. Premium Phase 1 migration gate hardening (after consumer baseline)
