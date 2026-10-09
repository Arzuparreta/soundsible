#!/usr/bin/env bash
# Install the built Linux package, and what the UI smoke needs, on a fresh
# container of one of the distributions Desktop Build checks. Run as root.
#
#   install-linux-package.sh debian|fedora|arch PACKAGE_DIR
#
# The distribution's own FFmpeg goes in first: the package has to install
# next to it, and v0.21.1's did not, because it put its bundled copy in
# /usr/bin.
set -euo pipefail

distro="$1"
packages="$(realpath "$2")"
root="$(cd "$(dirname "$0")/../.." && pwd)"

case "$distro" in
  debian)
    export DEBIAN_FRONTEND=noninteractive
    apt-get -o Acquire::Retries=3 update
    apt-get -o Acquire::Retries=3 install -y --no-install-recommends ffmpeg
    apt-get -o Acquire::Retries=3 install -y --no-install-recommends "$packages"/*.deb \
      webkit2gtk-driver xvfb xauth dbus dbus-x11 pulseaudio pulseaudio-utils scrot python3 procps systemd
    ;;
  fedora)
    dnf -y install ffmpeg-free
    # Fedora, like Arch, packages WebKitWebDriver only with WebKitGTK 6.0.
    # --allowerasing: the image's pipewire-pulseaudio gives way to the
    # PulseAudio daemon the smoke starts.
    dnf -y install --allowerasing "$packages"/*.rpm webkitgtk6.0 xorg-x11-server-Xvfb xorg-x11-xauth \
      dbus-daemon dbus-tools pulseaudio pulseaudio-utils scrot python3 procps-ng systemd util-linux
    ;;
  arch)
    pacman -Syu --noconfirm --needed base-devel python ffmpeg webkitgtk-6.0 \
      xorg-server-xvfb xorg-xauth pulseaudio libpulse scrot procps-ng
    # Build the package the way an AUR user would: from the generated
    # PKGBUILD, as a normal user, against the .deb it downloads. The .deb
    # and LICENSE are placed where makepkg looks before downloading.
    id builder >/dev/null 2>&1 || useradd -m builder
    deb="$(echo "$packages"/Soundsible_*_amd64.deb)"
    version="$(basename "$deb" | sed -E 's/^Soundsible_(.*)_amd64\.deb$/\1/')"
    work="$(mktemp -d)"
    python3 "$root/scripts/linux_packages.py" aur --deb "$deb" --out "$work" --version "$version"
    cp "$deb" "$work/"
    cp "$root/LICENSE" "$work/LICENSE-$version"
    chown -R builder "$work"
    (cd "$work" && runuser -u builder -- makepkg --printsrcinfo > .SRCINFO && cat .SRCINFO)
    # --nodeps: nothing is compiled, and pacman -U resolves the runtime
    # dependencies from the repositories, which proves their names exist.
    (cd "$work" && runuser -u builder -- makepkg --nodeps --noconfirm)
    pacman -U --noconfirm "$work"/soundsible-bin-*.pkg.tar.zst
    pacman -Ql soundsible-bin
    ;;
  *)
    echo "usage: $0 debian|fedora|arch PACKAGE_DIR" >&2
    exit 2
    ;;
esac
