# Linux packages

The desktop app reaches Linux in four forms. All four carry the same binaries:
CI builds the app once, as a `.deb`, and the other three repackage it.

| Package | For | Install |
| --- | --- | --- |
| `Soundsible_<version>_amd64.deb` | Debian 12+, Ubuntu 22.04+, Mint | `sudo apt install ./Soundsible_<version>_amd64.deb` |
| `soundsible-<version>-1.x86_64.rpm` | Fedora | `sudo dnf install ./soundsible-<version>-1.x86_64.rpm` |
| | openSUSE (not tested in CI) | `sudo zypper install --allow-unsigned-rpm ./soundsible-<version>-1.x86_64.rpm` |
| `Soundsible_<version>_x86_64.flatpak` | Any distribution with Flatpak | `flatpak install --user ./Soundsible_<version>_x86_64.flatpak` |
| `soundsible-bin` (AUR, once [publishing is set up](#setting-up-publishing-once)) | Arch, Manjaro, EndeavourOS, CachyOS | `yay -S soundsible-bin` |

The files are attached to every [release](https://github.com/Arzuparreta/soundsible/releases).
Only x86-64 is built.

## Why Ubuntu 22.04

A Linux program runs on the glibc it was linked against and on newer ones,
never on older. Built on Ubuntu 24.04, as the `.deb` used to be, the engine
needed glibc 2.38 and did not start on Debian 12 or Ubuntu 22.04. The packages are now
built in an Ubuntu 22.04 container (glibc 2.35), the oldest release they
support.

## AAC playback

The app plays through WebKitGTK, which decodes with the distribution's
GStreamer. Downloads are AAC in an `.m4a`, and on Debian and Ubuntu nothing
WebKit pulls in decodes AAC, not even with recommended packages: the song
loads and never plays. The `.deb` therefore depends on `gstreamer1.0-libav`
(set in `desktop-shell/src-tauri/tauri.linux.conf.json`), and
`soundsible-bin` on `gst-libav`. Fedora decodes AAC with what WebKitGTK
already installs. Every smoke below plays an AAC track to keep it that way.

## RPM

The `.rpm` is built by `scripts/linux_packages.py rpm` with `rpmbuild`, from
the `.deb`'s files and `desktop-shell/packaging/linux/rpm/soundsible.spec.in`.
Tauri can bundle an RPM itself, but its bundler took 45 minutes over the
frozen engine on CI, against seconds for rpmbuild. The spec requires
libraries rather than packages, so that Fedora and openSUSE, which name the
packages differently, both resolve them.

## Flatpak

The Flatpak uses the GNOME 50 runtime, which provides WebKitGTK 4.1. Its
manifest is `desktop-shell/packaging/linux/flatpak/`; it adds the
libayatana-appindicator tray library from Flathub's shared modules and
installs the `.deb`'s binaries without stripping them (stripping cuts off the
engine's embedded Python).

What it can reach:

- **Your music.** Only `~/Music` and `~/Downloads`. A library elsewhere needs
  a one-time grant:

  ```sh
  flatpak override --user --filesystem=/path/to/music io.github.Arzuparreta.Soundsible
  ```

- **The network**, for the local engine on `127.0.0.1`, stations elsewhere,
  search and downloads.
- **Sound** through PulseAudio or PipeWire, **media keys** through MPRIS, and
  the **tray**.

**Start at login** goes through the desktop's Background portal, which may ask
for permission. The usual tauri-plugin-autostart entry would point at a path
that only exists inside the sandbox. On a desktop whose portal has no
Background interface, the box stays unchecked and the app starts as usual.

A `.flatpak` file does not update itself: install the next one over it. Flathub
would provide automatic updates. It is not published there yet — see
[Flathub](#flathub).

### Graphics on NVIDIA

The Flatpak uses WebKit's shared-memory frame transport by default. NVIDIA can
reject its GBM buffers, leaving a blank window even though the native menus
appear. `WEBKIT_DMABUF_RENDERER_FORCE_SHM=1` avoids that transfer path while
keeping hardware acceleration available. It trades zero-copy frame transfer
for compatibility; it does not disable the GPU or WebKit's compositor.

For an already installed bundle, apply the same setting and restart the app:

```sh
flatpak override --user --env=WEBKIT_DISABLE_DMABUF_RENDERER=0 \
  --env=WEBKIT_DMABUF_RENDERER_FORCE_SHM=1 io.github.Arzuparreta.Soundsible
```

Setting `WEBKIT_DISABLE_DMABUF_RENDERER=1` is a different workaround: it also
disables WebKit hardware acceleration and can make the player slow. The `=0`
above cancels that earlier workaround. WebKit's
[buffer transport selection](https://github.com/WebKit/WebKit/blob/webkitgtk-2.54.1/Source/WebKit/UIProcess/gtk/AcceleratedBackingStore.cpp)
defines this distinction. On a system where DMA-BUF works, an override with
`--env=WEBKIT_DMABUF_RENDERER_FORCE_SHM=0` restores the runtime's default path.

A graphics workaround does not prove audio crash recovery. A WebKit process
abort during playback needs separate investigation; preserve its logs and
`coredumpctl info` output rather than treating a visible window as acceptance.

### Stale frames after animations

WebKitGTK 2.54 — the GNOME 50 runtime's, and Arch's — composites with Skia,
and that compositor presents an old frame as a CSS animation ends: opening or
closing Now Playing flashed the screen as it was when the slide began. With
shared-memory transport it happened on 5 to 8 of 16 transitions under Xvfb;
with `WEBKIT_USE_SKIA_FOR_COMPOSITION=0`, WebKit's previous compositor, on
none, with the same number of animation frames and acceleration kept.
`WEBKIT_DISABLE_DMABUF_RENDERER=1` also removed it, but drew each slide in 3
or 4 frames instead of 15.

The app sets `WEBKIT_USE_SKIA_FOR_COMPOSITION=0` itself on Linux at start
(`desktop-shell/src-tauri/src/main.rs`) unless the variable is already set,
so `flatpak override --env=WEBKIT_USE_SKIA_FOR_COMPOSITION=1` brings Skia
back to compare. Every Linux smoke films Now Playing opening and closing and
fails on a frame that returns to an older image.

## AUR

The AUR stores a recipe rather than binaries. `soundsible-bin`'s `PKGBUILD`
downloads the `.deb` from the GitHub release, checks its SHA-256 and repackages
it. `yay`, `paru` or plain `makepkg` build it on the user's machine.

The `PKGBUILD` is generated from
`desktop-shell/packaging/linux/aur/PKGBUILD.in` by
`scripts/linux_packages.py aur`, which fills in the version and the
checksums. On every non-prerelease tag, the release workflow's `aur` job
regenerates it, writes `.SRCINFO` with `makepkg --printsrcinfo`, and pushes
both to `ssh://aur@aur.archlinux.org/soundsible-bin.git`.

### Setting up publishing (once)

Until this is done, the `aur` job warns and skips; nothing fails.

1. Create an account on [aur.archlinux.org](https://aur.archlinux.org/register).
2. Generate a key pair just for this. Do not reuse a personal key:

   ```sh
   ssh-keygen -t ed25519 -N '' -C soundsible-aur -f ~/.ssh/soundsible-aur
   ```

3. Paste `~/.ssh/soundsible-aur.pub` into **My Account → SSH Public Key** on
   the AUR.
4. Give the private key to the release workflow:

   ```sh
   gh secret set AUR_SSH_PRIVATE_KEY --repo Arzuparreta/soundsible < ~/.ssh/soundsible-aur
   ```

The next release creates the `soundsible-bin` package on its first push. The
account that owns the key becomes its maintainer. To publish before the next
release, re-run the `aur` job of the latest release run.

The AUR's [submission guidelines](https://wiki.archlinux.org/title/AUR_submission_guidelines)
apply: the `-bin` suffix marks a repackaged binary, and the package must keep
working or it can be orphaned. Getting into Arch's official `extra` repository
is not something to apply for. A Package Maintainer has to adopt the package,
usually after it has collected votes in the AUR, and would build it from
source.

## What CI proves

Desktop Build (`.github/workflows/desktop-build.yml`):

| Job | Checks |
| --- | --- |
| `build-linux` | Builds the engine and the `.deb` in Ubuntu 22.04, then the `.rpm` from the `.deb` with rpmbuild; engine smoke; Rust and D-Bus tests |
| `smoke-linux-ubuntu` | The `.deb` installed with apt on the newest Ubuntu runner, next to Ubuntu's FFmpeg |
| `smoke-linux-debian` | The `.deb` on Debian 12, the oldest glibc it claims |
| `smoke-linux-fedora` | The `.rpm` installed with dnf on Fedora |
| `smoke-linux-arch` | `soundsible-bin` built with makepkg from the generated PKGBUILD and installed with pacman |
| `build-flatpak` | AppStream validation and the Flatpak bundle, built with Flathub's image |
| `smoke-flatpak` | The bundle installed with `flatpak install` and driven inside its sandbox |

Every smoke runs `desktop-shell/scripts/linux_ui_smoke.py` against the
installed app: a WAV and an AAC (`.m4a`) track on an independent station, advancing audio,
MPRIS control, the remote-command denial and the client's exit. In the
containers WebKit's own process sandbox is disabled, because unprivileged
containers cannot create the user namespaces it needs. The Ubuntu smoke runs
with it. WebKit without a GPU occasionally loses its web process under Xvfb,
so a failed smoke runs once more and keeps the first attempt's evidence in
`first-attempt/`; a package that is really broken fails both.

To reproduce a distribution's run locally with the packages from a CI run:

```sh
docker run --rm -it -v "$PWD:/src" -w /src fedora:44 \
  desktop-shell/scripts/install-linux-package.sh fedora packages/rpm
```

## Flathub

The Flatpak is built so it can go to Flathub, but it has not been submitted.
Submitting means:

1. Opening a pull request against
   [flathub/flathub](https://github.com/flathub/flathub) (its `new-pr`
   branch) with a manifest whose `soundsible.deb` source is the release URL
   plus its `sha256`, instead of a local file. `x-checker-data` can then
   propose each new release automatically.
2. Passing review. Outside Flathub, `flatpak-builder-lint repo` reports only
   that the screenshots are not mirrored, which Flathub's own build does.
3. Maintaining the `flathub/io.github.Arzuparreta.Soundsible` repository
   Flathub creates, where every update lands.

The app ID is `io.github.Arzuparreta.Soundsible` because Flathub requires an
ID the developer can prove they control, and the project has no domain of its
own. The Tauri identifier stays `org.soundsible.desktop`: changing it would
turn existing Windows installations into a second app.
