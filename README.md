<div align="center">

<img src="branding/logo-app.png" alt="Soundsible" width="120">

# Soundsible

**Your own music streaming server. Private, free, and yours.**

[![Website](https://img.shields.io/badge/website-soundsible-E0BC00?style=for-the-badge)](https://arzuparreta.github.io/soundsible.github.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/python-3.10+-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey?style=for-the-badge)]()

[**Install**](#install) · [**Documentation**](#documentation) · [**Website**](https://arzuparreta.github.io/soundsible.github.io) · [**Contributing**](CONTRIBUTING.md)

</div>

---

## What is Soundsible?

Soundsible is a music app you run on your **own** machine. Browse, stream, and save music from YouTube, YouTube Music, and podcasts — in one clean player, on every device in your home. No ads, no tracking, no subscription.

| Source | What it gives you |
| ------------------- | ------------------------------------ |
| **YouTube** | A practically unlimited catalog |
| **YouTube Music** | Personalized recommendations |
| **iTunes Podcasts** | Podcasts in the same player |
| **Deezer** | Charts, discovery & clean metadata *(metadata only — no audio)* |

**What you get**

- 🎨 **Clean metadata & cover art** — accurate, not algorithmically mangled
- 🧠 **Private recommendations** built from *your own* listening history
- 📻 **Radio mode** for endless discovery without leaving your station
- 🗂️ **Everything in one place** — discover, search, podcasts, favourites, playlists, downloads
- 🧹 **Resilient downloads** — failed items stay visible with retry/remove, queue self-heals on restart
- 🔐 **It's your server** — your data never leaves it

> *"I built Soundsible because I'm a musician who understands how predatory music streaming has become — and a sysadmin with the tools to build a private, free alternative that doesn't sacrifice a thing."* — **Arzuparreta**

---

## Screenshots

<div align="center">

### Mobile

<table>
  <tr>
    <td align="center"><img src="docs/images/mobile-search.PNG" alt="Mobile search" width="190"><br><sub>Search</sub></td>
    <td align="center"><img src="docs/images/mobile-library.PNG" alt="Mobile library" width="190"><br><sub>Library</sub></td>
    <td align="center"><img src="docs/images/mobile-discover.PNG" alt="Mobile discover" width="190"><br><sub>Discover</sub></td>
    <td align="center"><img src="docs/images/mobile-np.PNG" alt="Mobile now playing" width="190"><br><sub>Now Playing</sub></td>
  </tr>
</table>

### Desktop

<img src="docs/images/desktop-library.png" alt="Desktop library" width="760">
<br><sub>Library</sub>
<br><br>
<img src="docs/images/desktop-np.png" alt="Desktop now playing" width="760">
<br><sub>Now Playing</sub>

</div>

---

## Install

Soundsible runs anywhere Python does. You need **Python 3.10+**, **git**, and **FFmpeg** — the steps below install all three.

### 👉 Pick your OS — click to expand

<details>
<summary><b>🐧 &nbsp; Linux</b></summary>
<br>

```bash
# 1. Install prerequisites (Debian / Ubuntu)
sudo apt install -y git ffmpeg python3 python3-venv python3-pip

# 2. Get Soundsible
git clone https://github.com/Arzuparreta/soundsible.git
cd soundsible

# 3. Run it
python3 run.py
```

**Other distros** — swap step 1:

- **Arch:** `sudo pacman -S git ffmpeg python python-pip`
- **Fedora:** `sudo dnf install git ffmpeg python3 python3-pip`

</details>

<details>
<summary><b>🍎 &nbsp; macOS</b></summary>
<br>

Requires [Homebrew](https://brew.sh).

```bash
# 1. Install prerequisites
brew install git ffmpeg python

# 2. Get Soundsible
git clone https://github.com/Arzuparreta/soundsible.git
cd soundsible

# 3. Run it
python3 run.py
```

</details>

<details>
<summary><b>🪟 &nbsp; Windows</b></summary>
<br>

In **PowerShell**:

```powershell
# 1. Install prerequisites
winget install Git.Git Python.Python.3.12 Gyan.FFmpeg

# 2. Close and reopen PowerShell so the new tools are on PATH, then:
git clone https://github.com/Arzuparreta/soundsible.git
cd soundsible

# 3. Run it
python run.py
```

No `winget`? Install [Git](https://git-scm.com/download/win), [Python](https://www.python.org/downloads/) (tick *"Add to PATH"*), and [FFmpeg](https://ffmpeg.org/download.html) manually.

</details>

### First run

The first `run.py` builds its environment and opens a **setup wizard** in your browser — pick your music folder and storage, and you're set. After that:

```bash
python3 run.py          # choose "Start Station Engine & Open Station"
```

Then open **<http://localhost:5005/player/>** and start listening. Keep the terminal open while you play; closing it stops the engine.

> **`new-ui` branch:** the player is one responsive SolidJS app. Its canonical
> URL is **<http://localhost:5005/player/>** on both desktop and mobile;
> **<http://localhost:5005/player/desktop/>** serves the same UI with the owner
> bootstrap used by the desktop shell. There is no separate `app.html` or mobile
> frontend. Build the branch once with `cd ui_web && npm ci && npm run build`
> before starting the engine. For frontend development, run `npm run dev` in
> `ui_web/` and open **<http://localhost:5173/player/>** while the engine runs on
> port 5005.

> 💡 Prefer a web control panel? Run `./venv/bin/python start_launcher.py`, open **<http://localhost:5099>**, and click **Launch Ecosystem**.

### Listen everywhere

- **On your phone (PWA)** — open the player on your phone, then *Share → Add to Home Screen* (iOS) or *Menu → Install app* (Android).
- **From anywhere** — reach your station over [Tailscale](https://tailscale.com/) at `http://<your-tailscale-ip>:5005/player/`.
- **Servers, reverse proxies, security** — see the [Install & Deployment guide](docs/INSTALL.md).

> 🖥️ **Desktop app (beta)** — a one-click app with no terminal is in the works. Track its status in [docs/DESKTOP_BETA.md](docs/DESKTOP_BETA.md).

---

## Documentation

| Guide | What's inside |
| ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| [Install & Deployment](docs/INSTALL.md) | Servers, headless/SSH, Tailscale, reverse proxy, storage, security |
| [Configuration](docs/CONFIGURATION.md) | Settings, environment variables, downloads, cookies |
| [Architecture](docs/ARCHITECTURE.md) | How Soundsible works, and how data flows |
| [Legal & Acceptable Use](docs/LEGAL.md) | Disclaimer and your responsibilities |
| [Contributing](CONTRIBUTING.md) | Dev setup and pull-request workflow |

<details>
<summary>Integrations & internals</summary>

| Document | Topic |
| ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| [Agent Integration](docs/AGENT_INTEGRATION.md) | API guide for OpenClaw, Hermes, and local assistants |
| [Car Integration](docs/CAR_INTEGRATION.md) | Car media surfaces and CarPlay path |
| [Desktop (Beta)](docs/DESKTOP_BETA.md) · [Desktop Shell](desktop-shell/README.md) | Desktop app status, build, and dev workflow |
| [Telemetry & Privacy](docs/TELEMETRY_PRIVACY.md) | Local-only telemetry contract |
| [yt-dlp formats troubleshooting](docs/troubleshooting-yt-dlp-formats.md) | Fixing download format / extractor issues |
| [Appliance Rework Plan](docs/appliance-rework-plan.md) · [Premium Quality Contract](docs/PREMIUM_QUALITY_CONTRACT.md) · [Layer Contracts](docs/LAYER_CONTRACTS.md) | Roadmap & internal contracts |

</details>

---

## Legal

> **Soundsible does not encourage or support piracy or Terms-of-Service violations.** It's a neutral tool for managing and streaming your own, legally obtained media. **You alone are responsible** for how you use it and for complying with applicable laws and platform terms. Full details in [docs/LEGAL.md](docs/LEGAL.md).

---

## Built with

Soundsible stands on the shoulders of these projects. FFmpeg is system-installed; the rest come in via `pip`.

| Project | License | Role |
| ------------------------------------------------------------- | ------------------ | ----------------------------------------------------------- |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Unlicense (PD) | YouTube / YouTube Music download & search |
| [Deezer public API](https://developers.deezer.com/) | Public API | Discovery metadata only (no audio streamed from Deezer) |
| [FFmpeg](https://ffmpeg.org/) | LGPL / GPL | Audio conversion & extraction |
| [ffmpeg-python](https://github.com/kkroening/ffmpeg-python) | Apache 2.0 | Python bindings for FFmpeg |

---

## Contributing

Bug reports, ideas, and pull requests are all welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, or open an [issue](https://github.com/Arzuparreta/soundsible/issues).

## License

Released under the **MIT License** — see [LICENSE](LICENSE).

---

<div align="center">

Built in public by **Arzuparreta** — musician & Linux sysadmin.

⭐ **Star the repo** &nbsp;·&nbsp; 🤝 **Contribute** &nbsp;·&nbsp; 👤 **Follow along**

[![GitHub followers](https://img.shields.io/github/followers/Arzuparreta?label=Follow&style=social)](https://github.com/Arzuparreta)
[![Twitter Follow](https://img.shields.io/twitter/follow/Arzuparreta?style=social)](https://twitter.com/Arzuparreta)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-Connect-0A66C2?style=flat&logo=linkedin&logoColor=white)](https://linkedin.com/in/Arzuparreta)

</div>
