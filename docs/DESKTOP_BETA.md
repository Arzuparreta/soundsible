# Desktop app (beta)

The Windows desktop app packages the Station Engine, the web player, FFmpeg and
ffprobe into one installer. You do not need Python, Git, Node.js, FFmpeg or a
terminal.

The installer also offers **Connect to server** for a station you already run
natively, in Docker or on another computer. See [Desktop client](DESKTOP_CLIENT.md)
for connection modes.

In **Use this computer as server** mode, it serves the computer it is installed on: its engine listens on `127.0.0.1`
on a random port, not on your network. To listen from a phone or another
computer, run Soundsible as a server instead — [natively](INSTALL.md) or with
[Docker](DOCKER.md).

## Downloads

Every [release](https://github.com/Arzuparreta/soundsible/releases) attaches:

| File | For | What CI checks |
| --- | --- | --- |
| `Soundsible_<version>_x64-setup.exe` | Windows 11 x64 | Installs, runs and uninstalls it through the real Windows UI ([below](#what-ci-proves)) |
| `Soundsible_<version>_arm64-setup.exe` | Windows 11 ARM64 | The same, on a native ARM64 runner |
There is no macOS build. On a Mac, use the [native installation](INSTALL.md)
or Docker.

### No Linux app

Linux has no desktop app. Run the station [natively](INSTALL.md) — as a
[systemd service](INSTALL.md#run-it-as-a-systemd-service) if it should start
at boot — or with [Docker](DOCKER.md), and open the player in a browser.
Chrome and other Chromium browsers install it as an app; Firefox plays it in a
tab. Both drive the desktop's media keys and widgets.

Earlier releases attached a Linux app (a `.deb`, later also an `.rpm` and a
Flatpak). It was withdrawn because on Linux a Tauri app renders the player
with WebKitGTK, not with the browser's engine: it was slower than the same
player in Chrome or Firefox, froze opening Now Playing on a laptop with Intel
graphics, and needed a workaround per WebKitGTK defect (no sound through a
MediaStream, stale frames from its compositor, a blank window on NVIDIA, no AAC
decoder on Debian and Ubuntu). An app that is worse than the browser has no
reason to exist. Remove an installed one with
`flatpak uninstall io.github.Arzuparreta.Soundsible`, `sudo apt remove
soundsible` or `sudo dnf remove soundsible`.

The Windows installers come with `SHA256SUMS-x64.txt` and
`SHA256SUMS-arm64.txt`, and carry build-provenance attestations you can check
with `gh attestation verify <installer> --repo Arzuparreta/soundsible`. They
are **not code-signed**, so Windows warns about an unknown publisher; see
[Stable-release blockers](#stable-release-blockers) for why.

The app carries the same version number as the rest of the release. "Beta"
describes the desktop shell's maturity, not a separate version — see
[Releasing](RELEASING.md).

## Using it

- **First run** offers a server address or the local music-folder flow,
  and offers to start Soundsible when you log in.
- **Closing the window** hides Soundsible in the tray and keeps playback
  running. **Quit** in the tray/window menu, or `Ctrl+Alt+Q`, exits and stops only
  the engine started by this app. External stations keep running. Without a
  usable tray, closing exits. The other tray actions and shortcuts are listed in the
  [desktop shell README](../desktop-shell/README.md#architecture).
- **Updating**: there is no automatic update. Install the newer release over
  the old one. Upgrading an existing installation has not had a human
  review yet (see [blockers](#stable-release-blockers)), so copy the
  [configuration directory](CONFIGURATION.md#7-where-soundsible-keeps-its-files)
  somewhere safe first.

## What CI proves

| Area | Automated gate |
|------|----------------|
| Windows 11 x64 | Native sidecar, FFmpeg, Tauri and NSIS build on `windows-latest`; real UI automation |
| Windows 11 ARM64 | Native build on `windows-11-arm`; PE architecture checks reject x64 payloads |
| First run | Official Tauri directory dialog, cancel/retry, Unicode path and scan validation |
| Engine | Sidecar readiness, health, player route, bundled audio conversion/probing and process shutdown |
| Lifecycle | Silent NSIS install, launch, hide-to-tray, restore, quit and uninstall |
| Evidence | Screenshots, Windows accessibility tree, logs, checksums and build provenance |

Windows ships as an NSIS `.exe` only; there is no MSI.

`.github/workflows/desktop-build.yml` exercises the interactive path on both
Windows architectures through the Windows UI Automation backend in
`pywinauto`:

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

The app stays in beta until these human checks exist:

- audible output through real Windows audio hardware;
- visual and keyboard review of the tray on a normal Windows 11 desktop;
- SmartScreen and Microsoft Defender behaviour for the distributed installer;
- upgrade review on a non-ephemeral user profile;
- code-signing identity and reputation.

An unsigned build must not be described or published as a stable Windows
release.

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

The release workflow builds the Windows x64 and ARM64 installers, emits SHA-256
manifests, adds GitHub build-provenance attestations to the installers, and
publishes them on a `v*` tag alongside the server
images. A release candidate — `vX.Y.Z-rc.N` — is marked as a prerelease and
never moves the `latest` container tag. See [RELEASING.md](RELEASING.md).

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
5. Decide and implement the stable update channel before publishing a stable
   desktop release.

## Same engine and player

The installers use the same Station Engine and web player sources as every
other installation, for x64 and ARM64; there is no separate, older feature
branch. The desktop package serves localhost; network/server use is a separate
installation mode.

The media bundle includes both `ffmpeg` and `ffprobe`. Library repair uses
ffprobe to inspect codecs and containers, and DJ analysis uses it to obtain
track durations. A standalone installation must not rely on a system FFmpeg
installation to provide the missing probe. Windows keeps the `.exe` suffix
for both tools, including inside the frozen engine.

Desktop CI and release builds exercise the bundled pair by generating FLAC
audio at a Unicode path and probing its codec and duration. Desktop checks
also run when the shared player, downloader, setup or web UI changes. This
checks media processing, not audible playback through Windows hardware.
