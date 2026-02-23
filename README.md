# Soundsible Station

**The Cloud-Native Audiophile WebUI.**

Soundsible Station is the flagship interface of the Soundsible ecosystem, a high-fidelity, self-hosted music platform for the post-streaming era. Engineered as a Progressive Web App (PWA) with native-grade performance, it transforms any browser into a dedicated audiophile console.

This repository contains the full Soundsible ecosystem, with the Station as its core component.

---

## 💎 Core Product: Soundsible Station (WebUI)

The **Station** is the primary, recommended interface for all users. It combines the precision of a dedicated hardware player with the ubiquity of the modern web, delivering a "Cyber-Premium" listening experience across your entire digital life.

### Key Features
- **Omni-Island Control**: A unified, gesture-driven navigation hub that seamlessly blends transport controls with deep-link navigation.
- **Universal Sync**: Your library, queue, and preferences float effortlessly between devices via the self-hosted backend.

### Getting Started
Launch the Station on your server:
```bash
./start_web.sh
```
Access via `http://localhost:5005` or your server's LAN IP. Add to Home Screen on iOS for the full immersive experience.

---

## 🔧 Legacy Support: Soundsible Desktop (GTK)

The **Desktop** client is a specialized, lightweight interface built for resource-constrained Linux environments or dedicated single-board computers (Raspberry Pi).

While it retains core playback functionality, it is maintained primarily as a legacy option for users requiring a native window manager footprint without the overhead of a full web stack.

### Usage
```bash
./gui.sh
```
*Note: The GTK client receives maintenance updates but may lag behind the Station in UI/UX features.*

---

## 🛠 Architecture

Soundsible is built on a robust, modular Python backend that serves as the single source of truth for your music library.

- **Backend**: Python/Flask (Metadata, Indexing, Audio Stream)
- **Frontend**: Vanilla JS / Tailwind CSS (Zero-dependency, high-performance)
- **Storage**: Local Filesystem + Optional Cloud Sync (Backblaze B2 / Cloudflare R2)

## 📦 Installation

Clone the repository and initialize the environment:

```bash
git clone https://github.com/Arzuparreta/soundsible.git
cd soundsible
./setup_tool/init.sh
```

## 📜 License

MIT License. Copyright © 2026.
