# Desktop app (beta)

The desktop app packages the Station Engine, the web player and FFmpeg into
one installer. You do not need Python, Git, Node.js, FFmpeg or a terminal.

It serves the computer it is installed on: its engine listens on `127.0.0.1`
on a random port, not on your network. To listen from a phone or another
computer, run Soundsible as a server instead — [natively](INSTALL.md) or with
[Docker](DOCKER.md).

## Downloads

Every [release](https://github.com/Arzuparreta/soundsible/releases) attaches:

| File | For | What CI checks |
| --- | --- | --- |
| `Soundsible_<version>_x64-setup.exe` | Windows 11 x64 | Installs, runs and uninstalls it through the real Windows UI ([below](#what-ci-proves)) |
| `Soundsible_<version>_arm64-setup.exe` | Windows 11 ARM64 | The same, on a native ARM64 runner |
| `Soundsible_<version>_amd64.deb` | Debian and Ubuntu, x86-64 | Builds it and smoke-tests its engine; nothing installs or drives the app |

There is no macOS build. On a Mac, use the [native installation](INSTALL.md)
or Docker.

The Windows installers come with `SHA256SUMS-x64.txt` and
`SHA256SUMS-arm64.txt`, and carry build-provenance attestations you can check
with `gh attestation verify <installer> --repo Arzuparreta/soundsible`. They
are **not code-signed**, so Windows warns about an unknown publisher; see
[Stable-release blockers](#stable-release-blockers) for why.

The app carries the same version number as the rest of the release. "Beta"
describes the desktop shell's maturity, not a separate version — see
[Releasing](RELEASING.md).

## Using it

- **First run** asks for your music folder through the system's folder dialog,
  and offers to start Soundsible when you log in.
- **Closing the window** hides Soundsible in the tray and keeps playback
  running. **Quit** in the tray menu, or `Ctrl+Alt+Q`, stops the engine and
  exits. The other tray actions and shortcuts are listed in the
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
| Engine | Sidecar readiness, health, player route, FFmpeg availability and clean process shutdown |
| Lifecycle | Silent NSIS install, launch, hide-to-tray, restore, quit and uninstall |
| Evidence | Screenshots, Windows accessibility tree, logs, checksums and build provenance |

Windows ships as an NSIS `.exe` only; there is no MSI.

`.github/workflows/desktop-shell.yml` exercises the interactive path on both
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

On Linux, CI builds the PyInstaller sidecar and the Tauri shell and runs the
engine smoke test; the `.deb` itself is not installed or driven.

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

The release workflow builds the Windows x64 and ARM64 installers and the Linux
`.deb`, emits SHA-256 manifests, adds GitHub build-provenance attestations to
the Windows installers, and publishes them on a `v*` tag alongside the server
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
