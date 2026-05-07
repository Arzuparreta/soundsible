# 🎧 Soundsible

**A self-hosted music environment that respects your privacy and your wallet.**

> "I built Soundsible because I'm a musician who understands how predatory music streaming services have become. As a Linux SysAdmin, I had the tools to create something better: a private, free alternative that doesn't sacrifice any commodity."

— **Arzuparreta** (Musician & Linux SysAdmin)

[![Go to WEBSITE](https://img.shields.io/badge/GO%20TO%20WEBSITE-E0BC00?style=for-the-badge)](https://arzuparreta.github.io/soundsible.github.io)

## 🎵 What is Soundsible?

Soundsible is a **self-hosted music streaming environment** that lets you browse, listen, and save music **privately and for free** through:

- **YouTube** (vast catalog)
- **YouTube Music** (personalized recommendations)
- **iTunes Podcasts** (podcast integration)

Unlike commercial services, Soundsible gives you:
- ✅ **Original metadata and cover art** (reliable, not algorithmically twisted)
- ✅ **Local, private recommendations** based on YOUR listening history
- ✅ **Radio mode** for discovering similar music without leaving your own Station
- ✅ **Discover, search, podcasts, favourites, playlists, and downloads** in one place
- ✅ **Zero ads, zero tracking, zero revenue models** — just your music
- ✅ **Complete control** over your data (it's YOUR server after all)

## 🛡️ Why Soundsible?

As a **musician**, I've seen how streaming platforms exploit artists and listeners alike. As a **Linux SysAdmin**, I know that self-hosting is the only true path to digital freedom.

Soundsible aims to be a **sensible self-hosted alternative** to predatory music streaming services — without sacrificing any commodity whatsoever.

### The Philosophy
- **Privacy by design**: Everything stays local on your server
- **Free forever**: No subscriptions, no premium tiers, no hidden costs
- **Open source**: MIT License — inspect, modify, contribute
- **Musician-approved**: Built by someone who actually understands music

## 📱 Screenshots

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

## ⚠️ Legal Disclaimer

> **Soundsible does not encourage or support piracy or Terms-of-Service violations.**
> 
> It is a neutral tool for managing and streaming your own, legally obtained media; **you are solely responsible** for how you use it and for complying with all applicable laws and platform terms.
> 
> See [docs/LEGAL.md](docs/LEGAL.md) for full legal and acceptable-use details.

---

## 🚀 Quick Start

### Prerequisites

- **Python 3.10+**
- **git**
- **FFmpeg** — required for downloading and audio conversion
  - Debian/Ubuntu: `sudo apt install ffmpeg`
  - Arch: `sudo pacman -S ffmpeg`
  - macOS: `brew install ffmpeg`
  - Windows: [FFmpeg download](https://ffmpeg.org/download.html) or `winget install ffmpeg`
- **Linux**: `python3-venv` and `python3-pip` (package names may vary by distro)

### 1. Clone the repository

```bash
git clone https://github.com/Arzuparreta/soundsible.git
cd soundsible
```

### 2. First run (self-healing)

```bash
python3 run.py
```

This command bootstraps automatically on fresh clones:
- Creates `./venv` if missing
- Installs/updates `requirements.txt`
- Starts the launcher/CLI flow

### 3. Run Soundsible

**Launcher (recommended)** — from the project root:

```bash
./venv/bin/python start_launcher.py
```

- Open **http://localhost:5099** and click **Launch Ecosystem** to start the Station engine and open the Station
- **Keep this terminal open** while using Soundsible; closing it stops the engine
- Use **Stop** on the launcher page to shut down the engine cleanly

**CLI / SSH** — alternative for terminal lovers:

```bash
python3 run.py
```

- Choose **Start Station Engine & Open Station**
- Keep the terminal open while the engine runs
- Open **http://localhost:5005/player/** (or `http://<server-LAN-IP>:5005/player/` from another machine)

**Remote access** via [Tailscale](https://tailscale.com/): use **http://<your-tailscale-ip>:5005/player/** from any device on your tailnet.

### 4. Install as a web app (PWA)

- **iOS / Safari**: Share → **Add to Home Screen**
- **Android / Chrome**: Menu → **Install app**

---

## 📚 Documentation

- [Install & Deployment](docs/INSTALL.md) — headless server, Tailscale, reverse proxy, storage
- [Architecture](docs/ARCHITECTURE.md) — architecture and data flow (includes **Discover / Deezer proxy**)
- [Agent Integration](docs/AGENT_INTEGRATION.md) — API guide for OpenClaw, Hermes agents, and local assistants
- [Configuration](docs/CONFIGURATION.md) — configuration, environment variables, storage backends
- [Legal & Acceptable Use](docs/LEGAL.md) — legal details
- [Troubleshooting yt-dlp formats](docs/troubleshooting-yt-dlp-formats.md)

---

## 🔧 Third-party Components

Soundsible depends on these excellent projects. FFmpeg is system-installed; others are pulled in via `pip`:

- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — Unlicense (public domain). YouTube / YouTube Music download and search.
- **[Deezer public API](https://developers.deezer.com/)** — Discover uses read-only metadata (charts, playlists, tracks) via the Station's allowlisted HTTP proxy; audio is **not** streamed from Deezer.
- **[FFmpeg](https://ffmpeg.org/)** — LGPL/GPL. Audio conversion and extraction.
- **[ffmpeg-python](https://github.com/kkroening/ffmpeg-python)** — Apache 2.0. Python bindings for FFmpeg.

---

## 🤝 Contributing

Contributions, bug reports, and feature requests are welcome!

- See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.
- Open an issue for bugs or proposals.
- Pull requests for fixes and features are appreciated.

---

## 📄 License

Soundsible is released under the **MIT License**.

See [LICENSE](LICENSE) for the full text.

---

## 🎼 Who's Behind This?

I'm **Arzuparreta**, a musician who refused to accept the predatory music streaming status quo. As a **Linux SysAdmin**, I had the power to build something better.

- 🎵 **Musician**: I create music and understand what artists and listeners truly need.
- 🐧 **Linux SysAdmin**: I know how to build, deploy, and maintain self-hosted solutions.
- 🤖 **AI Builder**: I use AI to automate simple tasks and enhance creativity.

Soundsible is my contribution to the self-hosted community — a privacy-first, free alternative that doesn't compromise on features.

**If you like my work:**
- ⭐ Give this repo a star!
- 👤 Follow me on [GitHub](https://github.com/Arzuparreta)
- 🐦 Follow me on [Twitter/X](https://twitter.com/Arzuparreta)
- 💼 Connect on [LinkedIn](https://linkedin.com/in/Arzuparreta)

---

*Building in public — Linux, Music, and Code.* 🚀

[![GitHub followers](https://img.shields.io/github/followers/Arzuparreta?label=Follow&style=social)](https://github.com/Arzuparreta)
[![Twitter Follow](https://img.shields.io/twitter/follow/Arzuparreta?style=social)](https://twitter.com/Arzuparreta)
