# [<img src="branding/logo-app.png" alt="Soundsible" width="52" height="52" align="center"> **Soundsible**](https://arzuparreta.github.io/soundsible.github.io)

<p align="left">
  <a href="https://arzuparreta.github.io/soundsible.github.io"><img src="https://img.shields.io/badge/GO%20TO%20WEBSITE-E0BC00?style=for-the-badge" alt="View Soundsible repository"></a>
</p>

**Soundsible is a self-hosted music environment** — Browse privately and **for free** through **YouTube**, **Youtube Music** and **iTunes Podcasts**. Listen to or save music with original and reliable metadata and covers. Create your playlists. Explore through top grade **local, private recommendations** based on your listenings and favorites for music and podcasts.  
This is an open-source project with no ads or revenue. Everything is **local**, **private**, and aims to prrovide users a sensible self-hosted alternative to the predatory music streaming services everyone uses today, without sacrificing any comodity whatsoever.

[Advanced install & deployment](docs/INSTALL.md) · [Documentation](#documentation)

### Mobile

<p align="center">
  <img src="https://arzuparreta.github.io/soundsible.github.io/screenshots/mobile-yt-search.PNG" alt="Mobile YouTube Search" width="200">
  <img src="https://arzuparreta.github.io/soundsible.github.io/screenshots/mobile-songs-library.PNG" alt="Mobile Songs Library" width="200">
  <img src="https://arzuparreta.github.io/soundsible.github.io/screenshots/mobile-now-playing.PNG" alt="Mobile Now Playing" width="200">
</p>

### Desktop

<p align="center">
  <img src="https://arzuparreta.github.io/soundsible.github.io/screenshots/desktop-player-dark.png" alt="Desktop Player Dark" width="600">
</p>

---

## Legal disclaimer

> [!WARNING]
> **Soundsible does not encourage or support piracy or Terms‑of‑Service violations.**  
> It is a neutral tool for managing and streaming your own, legally obtained media; **you are solely responsible** for how you use it and for complying with all applicable laws and platform terms.  
> See [docs/LEGAL.md](docs/LEGAL.md) for full legal and acceptable‑use details.

---

## Contents

- [Install & run](#install--run)
- [Documentation](#documentation)
- [Third-party components](#third-party-components)
- [Contributing](#contributing)
- [License](#license)

---

## Install & run

### Prerequisites

- **Python 3.10+**
- **git**
- **FFmpeg** — required for downloading and audio conversion; install with your OS package manager (not bundled). Examples: `sudo apt install ffmpeg` (Debian/Ubuntu), `sudo pacman -S ffmpeg` (Arch), `brew install ffmpeg` (macOS). Windows: see [FFmpeg](https://ffmpeg.org/download.html) or `winget install ffmpeg`. More notes in [docs/INSTALL.md](docs/INSTALL.md).
- **Linux**: `python3-venv` and `python3-pip` (package names may vary by distro)

### 1. Clone the repository

```bash
git clone https://github.com/Arzuparreta/soundsible.git
cd soundsible
```

### 2. First run (recommended, self-healing)

```bash
python3 run.py
```

This command now bootstraps automatically on fresh clones:
- creates `./venv` if missing
- installs/updates `requirements.txt`
- starts the launcher/CLI flow

If `python3` is missing, install from [python.org](https://www.python.org/downloads/) or your package manager, for example:

```bash
sudo apt install python3 python3-venv python3-pip
```

**Windows (PowerShell):**

```powershell
python run.py
```

### 3. Run Soundsible

**Launcher (recommended)** — from the project root, using the venv’s Python:

```bash
./venv/bin/python start_launcher.py
```

- Open **http://localhost:5099** and click **Launch Ecosystem** to start the Station engine and open the Station.
- **Keep this terminal open** while you use Soundsible; closing it stops the engine.
- Use **Stop** on the launcher page to shut down the engine cleanly.

**Windows:** use `venv\Scripts\python.exe` instead of `./venv/bin/python` (same for `pip` above).

**CLI / SSH** — alternative when you prefer a terminal menu:

```bash
python3 run.py
```

- Choose **Start Station Engine & Open Station**.
- Keep the terminal open while the engine runs.
- Open **http://localhost:5005/player/** (or `http://<server-LAN-IP>:5005/player/` from another machine on the same network).

Remote access over [Tailscale](https://tailscale.com/): use **http://\<your-tailscale-ip\>:5005/player/** from a device on your tailnet. Further steps (headless servers, reverse proxies, storage) are in [docs/INSTALL.md](docs/INSTALL.md).

**Native share** (the device share sheet on iOS/Android for WhatsApp, Messages, etc.) needs a **secure context**: use **HTTPS** or open the player as **`http://localhost`**. Over plain HTTP using the server’s LAN address, browsers usually block **Web Share**; the player still copies the YouTube link.

The player UI adapts to desktop and mobile layouts.

### 4. Troubleshooting fresh clone errors

If you moved/re-cloned the repo and hit dependency errors (for example `ModuleNotFoundError: gevent`), run:

```bash
rm -rf venv
python3 run.py
```

This forces a clean bootstrap and dependency reinstall for the new clone location.

### Install as a web app (PWA)

- **iOS / Safari**: Share → **Add to Home Screen**
- **Android / Chrome**: Menu → **Install app**

---

## Documentation

- [docs/INSTALL.md](docs/INSTALL.md) — headless server, Tailscale, reverse proxy, storage
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — architecture and data flow (includes **Discover / Deezer proxy**)
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — configuration, environment variables, storage backends
- [docs/LEGAL.md](docs/LEGAL.md) — legal and acceptable use

Troubleshooting:

- [docs/troubleshooting-yt-dlp-formats.md](docs/troubleshooting-yt-dlp-formats.md)

---

## Third-party components

Soundsible depends on the following. FFmpeg is system-installed; others are pulled in via `pip` where applicable.

- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — Unlicense (public domain). YouTube / YouTube Music download and search.
- **[Deezer public API](https://developers.deezer.com/)** — Discover uses read-only metadata (charts, playlists, tracks) via the Station’s allowlisted HTTP proxy; audio is **not** streamed from Deezer.
- **[FFmpeg](https://ffmpeg.org/)** — LGPL/GPL. Audio conversion and extraction.
- **[ffmpeg-python](https://github.com/kkroening/ffmpeg-python)** — Apache 2.0. Python bindings for FFmpeg.

---

## Contributing

Contributions, bug reports, and feature requests are welcome.

- See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.
- Open an issue for bugs or proposals; pull requests for fixes and features are appreciated.

---

## License

Soundsible is released under the **MIT License**.  
See [LICENSE](LICENSE) for the full text.
