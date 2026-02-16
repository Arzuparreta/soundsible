# Soundsible: The Universal Music Ecosystem

Soundsible is a high-fidelity, modular media platform designed for absolute data sovereignty and an uncompromised listening experience. It unifies your local files (NAS), cloud storage (Cloudflare R2, Backblaze B2, S3), and streaming capabilities into a single, resilient ecosystem featuring a high-end, mobile-first **Omni-Island** control system.

## 🌟 The Soundsible Philosophy
- **Omni-Island Control**: A unified, state-driven capsule that anchors the entire experience. It adapts fluidly between playback transport and technical navigation.
- **Cyber-Premium Design**: A sophisticated blend of high-end glassmorphism (`blur(40px)`), Apple-inspired layouts, and JetBrains-inspired technical accents.
- **Surgical Intentionality**: Advanced "Safe Release" touch logic and coordinate-based zone detection ensure zero accidental triggers on mobile.
- **Privacy & Sovereignty**: You own your files, your metadata, and your infrastructure. All credentials remain encrypted on your "Home Station."

---

## 🚀 Getting Started

### 1. Installation
Ensure you have **Python 3.10+** and **FFMPEG** installed.
```bash
git clone https://github.com/youruser/soundsible.git
cd soundsible
python3 run.py
```
*The launcher will automatically set up a virtual environment and install all necessary dependencies.*

### 2. Initial Setup
Run the guided setup to link your storage:
- **Option 5 (Manage Storage)** -> **Option 1 (Setup Wizard)**.
- Follow the prompts to link your **Cloudflare R2**, **Backblaze B2**, or **NAS**.

### 3. Populating Your Library
- **Deep Scan**: Point Soundsible to your large NAS folders to index them instantly without moving files.
- **Metadata Surgeon**: Use the integrated technical editor to auto-fetch high-resolution covers and harmonize tags against global standards.
- **Grow Your Station**: Use the **ODST Tool** to download directly from Spotify or YouTube URLs with bit-perfect quality.

---

## 📱 The Mobile Experience (PWA)

Soundsible is optimized for a native-app feel on iPhone and Android. Launch the **Web Station (Option 3)** and add it to your home screen.

### The Omni-Island Interface
The bottom-center capsule is your cockpit:
- **Playback (Active Mode)**: A sleek 286px capsule with [Prev], [Anchor], and [Next] controls.
- **Navigation (Bloom Mode)**: Hold the center for 400ms to reveal a symmetrical 7-slot navigation grid.
- **Adaptive Physics**: The island dynamically expands and retracts based on your interaction state.
- **Technical Scroller**: A JetBrains Mono marquee runs technical metadata in the background of the island.

### Core Interactions
- **Safe Release**: Taps only trigger if you release inside the zone. Slide your finger away to cancel any action.
- **Subtle Inflation**: High-end visual feedback where buttons "breathe" ऑर्गेनिकally when touched.
- **Card Deck Navigation**: Views slide OVER each other with "Premium Slime" physics (`cubic-bezier(0.19, 1, 0.22, 1)`).
- **Gestures**: 
    - **Swipe Right**: Add to Queue.
    - **Swipe Left**: Toggle Favourite.
    - **Pull Down**: Dismiss Now Playing or Action Menus (14% threshold).

---

## 💻 Desktop & Advanced
- **Linux (GTK4 / Adwaita)**: High-fidelity native player with MPRIS and system-level integration.
- **Smart Resolver**: Connection Race logic pings Local, Tailscale, and Cloud paths simultaneously to lock onto the fastest streaming route.
- **Technical Deep-Dive**: See the **[Advanced Documentation](ADVANCED.md)** for architecture and API specs.

## License
MIT License. Created for the love of music and technical freedom.
