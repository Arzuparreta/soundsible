# Soundsible: The Universal Music Ecosystem

Soundsible is a modular, high-fidelity media platform designed to give you absolute control over your music library. It unifies your local files (NAS), cloud storage (Cloudflare R2, Backblaze B2, S3), and streaming capabilities into a single, resilient ecosystem that works perfectly on your desktop and your phone.

## 🌟 The Soundsible Philosophy
- **Your Music, Everywhere**: Access your entire library from a single "Home Station" API.
- **Hybrid Streaming**: Seamlessly switch between high-speed local LAN playback and secure cloud streaming when you're away.
- **Tactile Control**: Optimized for touch devices with modern gestures.
- **Privacy First**: All credentials and tokens are encrypted locally on your machine.

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
- **Upload**: Use the CLI or Web Station to upload your existing music collection.
- **Deep Scan**: Point Soundsible to your large NAS folders to index them instantly without moving files.
- **Download**: Use the integrated **ODST Tool** to grow your library directly from Spotify or YouTube URLs.

---

## 📱 Using the Web Player (Mobile/Windows)

Launch the **Web Station (Option 3)** and open the provided URL on your device.

### Core Interactions
- **Smart Playback**: Tap any song to stream. The "Smart Resolver" automatically finds the fastest path (Local -> Cache -> Cloud).
- **Manage Favourites**: **Swipe Right** on any song row to toggle the yellow favourite indicator (synced with your PC).
- **Delete Tracks**: **Swipe Left** to permanently remove a song from your Station and Cloud storage (requires confirmation).
- **Search**: Real-time searching across your entire library using high-speed database indexing.

### Remote Downloader
- Go to the **Downloads** tab.
- Paste multiple Spotify/YouTube links (one per line).
- Click **Start Processing** to trigger the background engine on your Home Station.
- **Spotify Integration**: Browse your Spotify playlists and liked songs directly to bulk-add them to your library.

---

## 💻 Desktop Interfaces

### Linux (GTK4 / Adwaita)
A high-fidelity native player featuring:
- Album grid browsing.
- MPRIS integration (Control playback via system media keys).
- Automatic cover art extraction and display.

### Windows (Control Center)
A lightweight management dashboard that lives in your system tray, providing quick access to storage settings and library stats.

---

## 🌐 Connectivity & Networking

### The "Smart Resolver"
Soundsible uses a **Connection Race** logic. When you open the Web Player, it pings your Local IP, your Tailscale IP, and Localhost simultaneously, locking onto the fastest one.

### Tailscale (Recommended)
For the most stable remote experience, use **Tailscale**. It allows you to access your Home Station from anywhere in the world as if you were on your home Wi-Fi, with zero port forwarding required.

---

## 🛠 Advanced Features
For system architecture, API documentation, and developer tools, see the **[Advanced Documentation](ADVANCED.md)**.

## License
MIT License. Created for the love of music and technical freedom.
