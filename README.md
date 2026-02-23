# Soundsible Station

**The Cloud-Native Audiophile WebUI.**

Soundsible Station is the flagship interface of the Soundsible ecosystem, a high-fidelity, self-hosted music platform for the post-streaming era. Engineered as a Progressive Web App (PWA) with native-grade performance, it transforms any browser into a dedicated audiophile console.

This repository contains the full Soundsible ecosystem, with the Station as its core component.

---

## Sounsible Station

The **Station** is the primary, recommended interface for all users. It combines the precision of a dedicated hardware player with the ubiquity of the modern web, delivering a "Cyber-Premium" listening experience across your entire digital life.

### Key Features
- **Omni-Island Control**: A unified, gesture-driven navigation hub that seamlessly blends transport controls with deep-link navigation.
- **Universal Sync**: Your library, queue, and preferences float effortlessly between devices via the self-hosted backend.

### Getting Started
After [installation](#-installation), run the launcher and open the Station in your browser:
```bash
python run.py
```
Then open **http://localhost:5005/player/** (or your server’s LAN IP). Add to Home Screen on iOS for the full immersive experience.

---

## 📦 Installation

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

**After install:**

- **Station (main web UI):** run the launcher — `python run.py` (or `./venv/bin/python run.py`). Open **http://localhost:5005/player/** in your browser.
- **Cloud storage (optional):** to attach R2/B2/S3, run once: `./venv/bin/python -m setup_tool init`.

---

## Legacy option: Desktop (GTK)

A lightweight native client for **low-end or resource-constrained devices** (e.g. Raspberry Pi, thin clients, older Linux boxes). Uses less RAM than the web stack; core playback only. May lag behind the Station in UI/UX.

```bash
./gui.sh
```
*First run will create the venv and install dependencies; on some distros you may need system packages (GTK, mpv, LibAdwaita) — the script will prompt.*

---

## Architecture

- **Backend**: Python/Flask (Metadata, Indexing, Audio Stream)
- **Frontend**: Vanilla JS / Tailwind CSS (Zero-dependency, high-performance)
- **Storage**: Local Filesystem + Optional Cloud Sync (Backblaze B2 / Cloudflare R2)
