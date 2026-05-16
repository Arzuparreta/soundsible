<div align="center">

<img src="branding/logo-app.png" alt="Soundsible" width="140">

# Soundsible

**A self-hosted music environment that respects your privacy and your wallet.**

[![Website](https://img.shields.io/badge/website-soundsible-E0BC00?style=for-the-badge)](https://arzuparreta.github.io/soundsible.github.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/python-3.10+-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey?style=for-the-badge)]()

</div>

---

> *"I built Soundsible because I'm a musician who understands how predatory music streaming services have become. As a system designer, I had the tools to create something better: a private, free alternative that doesn't sacrifice any commodity."*
>
> — **Arzuparreta**, Musician & Linux SysAdmin

---

## Overview

Soundsible is a **self-hosted music streaming environment** that lets you browse, listen, and save music **privately and for free** from multiple sources, in one cohesive player.

| Source              | Purpose                              |
| ------------------- | ------------------------------------ |
| **YouTube**         | Vast, virtually unlimited catalog    |
| **YouTube Music**   | Personalized recommendations         |
| **iTunes Podcasts** | Podcast integration                  |
| **Deezer (meta)**   | Discover, charts & reliable metadata |

### Why Soundsible?

- 🎨 **Original metadata & cover art** — reliable, not algorithmically twisted
- 🧠 **Local, private recommendations** based on *your* listening history
- 📻 **Radio mode** for discovering similar music without leaving your Station
- 🗂️ **Discover, search, podcasts, favourites, playlists, and downloads** in one place
- 🚫 **Zero ads, zero tracking, zero revenue models** — just your music
- 🔐 **Complete control** over your data — it's your server, after all

---

## Screenshots

<div align="center">

### Mobile

<img src="https://arzuparreta.github.io/soundsible.github.io/screenshots/mobile-yt-search.PNG" alt="Mobile YouTube Search" width="220">
<img src="https://arzuparreta.github.io/soundsible.github.io/screenshots/mobile-songs-library.PNG" alt="Mobile Songs Library" width="220">
<img src="https://arzuparreta.github.io/soundsible.github.io/screenshots/mobile-now-playing.PNG" alt="Mobile Now Playing" width="220">

### Desktop

<img src="https://arzuparreta.github.io/soundsible.github.io/screenshots/desktop-player-dark.png" alt="Desktop Player" width="720">

</div>

---

## Philosophy

As a **musician**, I've seen how streaming platforms exploit artists and listeners alike. As a **Linux SysAdmin**, I know that self-hosting is the only true path to digital freedom.

Soundsible aims to be a **sensible self-hosted alternative** to predatory music streaming services — without sacrificing any commodity whatsoever.

- **Privacy by design** — everything stays local on your server
- **Free forever** — no subscriptions, no premium tiers, no hidden costs
- **Open source** — MIT licensed; inspect, modify, contribute
- **Musician-approved** — built by someone who actually needs to carry music around

---

## Quick Start

### Prerequisites

- **Python 3.10+**
- **git**
- **FFmpeg** — required for downloading and audio conversion
- **Linux only**: `python3-venv` and `python3-pip` (package names may vary by distro)

<details>
<summary><b>Install FFmpeg on your platform</b></summary>

| OS               | Command                                                                |
| ---------------- | ---------------------------------------------------------------------- |
| Debian / Ubuntu  | `sudo apt install ffmpeg`                                              |
| Arch             | `sudo pacman -S ffmpeg`                                                |
| macOS            | `brew install ffmpeg`                                                  |
| Windows          | `winget install ffmpeg` or [download](https://ffmpeg.org/download.html) |

</details>

### 1. Clone

```bash
git clone https://github.com/Arzuparreta/soundsible.git
cd soundsible
```

### 2. First run (self-healing bootstrap)

```bash
python3 run.py
```

On a fresh clone this automatically:

- Creates `./venv` if missing
- Installs / updates `requirements.txt`
- Starts the launcher / CLI flow

On minimal Ubuntu/Debian images, install the system Python packaging bits once before first run:

```bash
sudo apt install python3.12-venv python3-pip ffmpeg
```

### 3. Run Soundsible

**Launcher (recommended)** — from the project root:

```bash
./venv/bin/python start_launcher.py
```

- Open **<http://localhost:5099>** and click **Launch Ecosystem** to start the Station engine.
- **Keep this terminal open** while using Soundsible; closing it stops the engine.
- Use **Stop** on the launcher page to shut down the engine cleanly.

**CLI / SSH** — alternative for terminal lovers:

```bash
python3 run.py
```

- Choose **Start Station Engine & Open Station**
- Keep the terminal open while the engine runs
- Open **<http://localhost:5005/player/>** (or `http://<server-LAN-IP>:5005/player/` from another machine)

**Remote access** via [Tailscale](https://tailscale.com/): browse to `http://<your-tailscale-ip>:5005/player/` from any device on your tailnet.

### 4. Install as a PWA

- **iOS / Safari** — Share → **Add to Home Screen**
- **Android / Chrome** — Menu → **Install app**

---

## Legal Disclaimer

> **Soundsible does not encourage or support piracy or Terms-of-Service violations.**
>
> It is a neutral tool for managing and streaming your own, legally obtained media. **You are solely responsible** for how you use it and for complying with all applicable laws and platform terms.
>
> See [docs/LEGAL.md](docs/LEGAL.md) for full legal and acceptable-use details.

---

## Documentation

| Document                                                                | Topic                                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| [Install & Deployment](docs/INSTALL.md)                                 | Headless server, Tailscale, reverse proxy, storage            |
| [Architecture](docs/ARCHITECTURE.md)                                    | Architecture & data flow (includes Discover / Deezer proxy)   |
| [Agent Integration](docs/AGENT_INTEGRATION.md)                          | API guide for OpenClaw, Hermes agents, and local assistants   |
| [Configuration](docs/CONFIGURATION.md)                                  | Configuration, environment variables, storage backends        |
| [Legal & Acceptable Use](docs/LEGAL.md)                                 | Legal details                                                 |
| [yt-dlp formats troubleshooting](docs/troubleshooting-yt-dlp-formats.md) | Fixing format / extractor issues                              |

---

## Third-party Components

Soundsible stands on the shoulders of these excellent projects. FFmpeg is system-installed; the rest are pulled in via `pip`.

| Project                                                       | License            | Role                                                        |
| ------------------------------------------------------------- | ------------------ | ----------------------------------------------------------- |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp)                    | Unlicense (PD)     | YouTube / YouTube Music download & search                   |
| [Deezer public API](https://developers.deezer.com/)           | Public API         | Discover metadata only (audio is **not** streamed from Deezer) |
| [FFmpeg](https://ffmpeg.org/)                                 | LGPL / GPL         | Audio conversion & extraction                               |
| [ffmpeg-python](https://github.com/kkroening/ffmpeg-python)   | Apache 2.0         | Python bindings for FFmpeg                                  |

---

## Contributing

Contributions, bug reports, and feature requests are very welcome.

- Read [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.
- Open an [issue](https://github.com/Arzuparreta/soundsible/issues) for bugs or proposals.
- Submit a pull request for fixes and features.

---

## License

Soundsible is released under the **MIT License**. See [LICENSE](LICENSE) for the full text.

---

## About the Author

I'm **Arzuparreta** — a musician who refused to accept the predatory music streaming status quo, and a Linux SysAdmin with the tools to build something better.

- 🎵 **Musician** — I create music and understand what artists and listeners truly need
- 🐧 **Linux SysAdmin** — I build, deploy, and maintain self-hosted solutions
- 🤖 **AI Builder** — I use AI to automate the tedious and amplify the creative

Soundsible is my contribution to the self-hosted community — a privacy-first, free alternative that doesn't compromise on features.

<div align="center">

### If you like this project

⭐ **Star the repo** &nbsp;·&nbsp; 👤 **Follow along** &nbsp;·&nbsp; 🤝 **Contribute**

[![GitHub followers](https://img.shields.io/github/followers/Arzuparreta?label=Follow&style=social)](https://github.com/Arzuparreta)
[![Twitter Follow](https://img.shields.io/twitter/follow/Arzuparreta?style=social)](https://twitter.com/Arzuparreta)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-Connect-0A66C2?style=flat&logo=linkedin&logoColor=white)](https://linkedin.com/in/Arzuparreta)

*Building in public — Linux, Music, and Code.*

</div>
