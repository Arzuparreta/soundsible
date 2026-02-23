# <img src="branding/logo-app.png" alt="Soundsible" width="48" height="48" align="center"> **Soundsible**

**The Self-Hosted, full featured Music Environment.**

**Sounsible** is a, more or less complex piece of software that aims to **replicate how a high-end streaming music platform works**, and use that infrastructure to **download**, **manage** and **listen** to your **self-hosted** music, accesible from any device, anywhere in the world (with the aid of [Tailscale](https://github.com/tailscale/tailscale)).
I'm fully concerned about getting the closest experience possible to a third provided music platform, and I'm working everyday on features and quality of life.
This repository contains the full Soundsible ecosystem, with the Station as its core component.


## Station (Windows, Linux, Android, iOS):
The **Station** is the primary, recommended interface for all users. It combines the precision of a dedicated hardware player with the ubiquity of the modern web, delivering a premium listening experience across all your devices.

### Key Features:
- **Max quality**: Playback **engine** ensures **máximum quality**. Downloader tool defaults to **losless quality** and offer **manual quality selection**.
- **Setup Wizard on app launch**: Easy setup for setting absolutely every configuration needed for you to start streaming your music right now!
- **ODST Downloader**: Embeded downloader that downloads music from youtube or yt-music. It automatically fetches all the metadata including covers, and uploads it to your previously configured NAS (or desktop local) storage or third provided cloud (setup for Cloudflare R2, Backblaze R2 and S2 users on **Setup Wizard**).
- **Universal Sync**: Your library, playlists, queue, metadata, configurations... all synchronised along your devices.
- **Omni-Island Control**: A unified, gesture-driven navigation hub that seamlessly blends transport controls with deep-link navigation.

### Use cases:
- Full environment experience: [**Tailscale**](https://github.com/tailscale/tailscale) **(Recommended)**
   (Tailscale let's you access your running API from anywhere in the world, so you can listen to your streamed music anywhere)
- Only local playback: No extra configuration needed.
   (Just download and enjoy your local music)

---

## 📦 Installation:

**Requirements:** Python 3.10+ and `git`. On Linux you may need system packages (e.g. `python3-venv`, `python3-pip`).

**Quick (if you’re comfortable with venv):**

```bash
git clone https://github.com/Arzuparreta/soundsible.git
cd soundsible
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
```

**Step-by-step:**

1. Clone the repo and go into it:
   ```bash
   git clone https://github.com/Arzuparreta/soundsible.git
   cd soundsible
   ```
2. Create a virtual environment (so dependencies don’t touch system Python):
   ```bash
   python3 -m venv venv
   ```
   *If `python3` isn’t found, install Python 3 from [python.org](https://www.python.org/downloads/) or your package manager (e.g. `sudo apt install python3 python3-venv` on Debian/Ubuntu).*
3. Install dependencies:
   ```bash
   ./venv/bin/pip install -r requirements.txt
   ```
   *On Windows use `venv\Scripts\pip.exe` instead of `./venv/bin/pip`.*

## Getting Started!:
After [installation](#-installation), run the launcher and open the Station in your browser:
```bash
python run.py
```
- Then open **http://localhost:5005/player/** (or your server’s LAN IP).
- If you used [**Tailscale**](https://github.com/tailscale/tailscale), for example, you open **http://[your-tailscale-ip]:5005/player/**
This links redirects automatically to mobile or desktop versions.

### Add as a webapp on desktop and mobile for the full inmersive experience:
- iOS/Safari: Share > "Add to Home Screen"
- Android/Chrome: "More" > "Install"

---

## Legacy option: Desktop (GTK) (Linux):

A lightweight native client for **low-end or resource-constrained devices** (e.g. Raspberry Pi, thin clients, older Linux boxes). Uses less RAM than the web stack; core playback only. May lag behind the Station in UI/UX.

```bash
./gui.sh
```
*First run will create the venv and install dependencies; on some distros you may need system packages (GTK, mpv, LibAdwaita) — the script will prompt.*


## Architecture:

- **Backend**: Python/Flask (Metadata, Indexing, Audio Stream)
- **Frontend**: Vanilla JS / Tailwind CSS (Zero-dependency, high-performance)
- **Storage**: Local Filesystem + Optional Cloud Sync (Backblaze B2 / Cloudflare R2)
