# Soundsible Desktop — Windows 1.0 RC

The consumer desktop path is a Tauri shell plus a PyInstaller engine sidecar
and bundled FFmpeg. Users do not need Python, Git, FFmpeg, or a terminal.

## Current release-candidate contract

| Area | Automated gate |
|------|----------------|
| Windows 11 x64 | Native sidecar, FFmpeg, Tauri and NSIS build on `windows-latest`; real UI automation |
| Windows 11 ARM64 | Native build on `windows-11-arm`; PE architecture checks reject x64 payloads |
| First run | Official Tauri directory dialog, cancel/retry, Unicode path and scan validation |
| Engine | Sidecar readiness, health, player route, FFmpeg availability and clean process shutdown |
| Lifecycle | Silent NSIS install, launch, hide-to-tray, restore, quit and uninstall |
| Evidence | Screenshots, Windows accessibility tree, logs, checksums and build provenance |

The Windows product version is `1.0.0-rc.1`. Windows delivery is NSIS `.exe`
only. MSI is intentionally not part of the supported RC surface.

## What CI proves

`.github/workflows/desktop-shell.yml` exercises the interactive path on both
architectures through the Windows UI Automation backend in `pywinauto`:

1. install into a clean temporary location;
2. launch with an isolated configuration;
3. open and cancel the native folder dialog;
4. reopen it and select a Unicode test library;
5. wait for folder scan and engine health;
6. quit, relaunch and prove that the persisted library bypasses onboarding;
7. close to tray, restore with the global shortcut and quit cleanly;
8. verify no orphan engine remains;
9. uninstall and verify application binaries are removed.

`verify-pe-architecture.ps1` checks the machine field of the app, engine and
FFmpeg. ARM64 artifacts may not silently fall back to x64 emulation.

The browser-level shell suite separately checks cancellation, localization,
minimum-window layout and 200% zoom without overlap. The shared player keeps
its own Compact, Normal and Large accessibility matrix.

## What CI cannot prove

This remains a release candidate until these human gates exist:

- audible output through real Windows audio hardware;
- visual and keyboard review of the tray on a normal Windows 11 desktop;
- SmartScreen and Microsoft Defender behaviour for the distributed installer;
- upgrade review on a non-ephemeral user profile;
- code-signing identity and reputation.

An unsigned automated RC must not be described or published as the stable
Windows release.

## Build and release

Local frontend validation:

```bash
cd desktop-shell
npm ci
npm test
npm run test:ui
npm run frontend:build
```

Native Windows packaging:

```bash
BUNDLE_FFMPEG=1 ./desktop-shell/scripts/build-sidecar.sh
cd desktop-shell
npm run build
```

The release workflow builds x64 and ARM64 installers, emits SHA-256 manifests,
adds GitHub build-provenance attestations, and publishes them on a `v*` tag
alongside the server images. A release candidate — `vX.Y.Z-rc.N` — is marked as
a prerelease and never moves the `latest` container tag, so cutting one is the
deliberate act that used to be "press publish". See
[RELEASING.md](RELEASING.md).

## Stable-release blockers

1. Sign app, sidecar and installer with a Windows code-signing certificate.
   **Blocked by choice, not by work.** A certificate costs money and requires a
   legal identity, and Soundsible is not buying one. If the community funds it,
   the release workflow gains a signing step; until then the desktop app stays
   in beta and its installers ship unsigned, which is what the warning about an
   unknown publisher means. Nothing else on this list is waiting on it.
2. Complete one human Windows 11 x64 run and one ARM64 run.
3. Validate real playback, tray behaviour, Defender and SmartScreen.
4. Validate upgrade from the latest public beta without losing configuration.
5. Decide and implement the stable update channel before publishing `1.0.0`.
