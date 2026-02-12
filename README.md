# Soundsible: Universal Media Ecosystem

Soundsible is a professional-grade, cloud-native music platform designed for Linux. It provides a unified interface to stream your entire music collection from **cloud storage** (Cloudflare R2, Backblaze B2, S3) or **local servers (NAS)**, while maintaining a lightning-fast, local-first experience through intelligent LRU caching.

## Key Features

*   **Hybrid Streaming**: Seamlessly switch between streaming from the cloud and playing local files. It treats your NAS, local folders, and S3 buckets as a single, cohesive library.
*   **Intelligent Caching**: Automatically caches tracks as you listen. If your internet goes down, your recently played music stays available.
*   **Zero-Cost Cloud Support**: Optimized for Cloudflare R2 (zero egress fees) and Backblaze B2.
*   **Omni-Directional Downloader**: Integrated tools to pull music from YouTube and Spotify with automated "Gold Standard" metadata enrichment.
*   **Native Linux Experience**: Built with GTK4 and Adwaita for a modern GNOME-native feel, featuring MPRIS support, media keys, and gapless playback.
*   **Encrypted Sync**: Synchronize your library across multiple devices instantly using encrypted tokens or QR codes.

---

## Getting Started

### 1. System Requirements

Ensure your Linux distribution has the necessary dependencies:

```bash
# Ubuntu / Debian / Pop!_OS
sudo apt install ffmpeg libmpv1 python3-gi gir1.2-gtk-4.0 gir1.2-adw-1 playerctl

# Fedora
sudo dnf install ffmpeg mpv-libs python3-gobject gtk4 libadwaita playerctl

# Arch Linux
sudo pacman -S ffmpeg mpv python-gobject gtk4 libadwaita playerctl
```

### 2. Installation

Clone the repository and run the automated launcher. The launcher will handle virtual environment creation and dependency installation.

```bash
git clone https://github.com/Arzuparreta/soundsible.git
cd soundsible
python3 run.py
```

### 3. Initial Configuration

Soundsible is designed to be configured visually. Upon the first execution:

1.  The **Launcher** will detect a new installation and automatically start the **Music Player (GUI)**.
2.  The **Setup Wizard** will appear to guide you through:
    *   **Local Storage**: Pointing to your existing music folders or NAS.
    *   **Cloud Storage**: Connecting to Cloudflare R2, Backblaze B2, or S3 (Optional).
    *   **Library Sync**: Importing an existing library if you're setting up a second device.

---

## Ecosystem Modules

### 1. The Music Player (GUI)
The primary interface for high-fidelity listening.
*   **Gapless Playback**: Powered by the MPV engine.
*   **Dynamic UI**: Beautiful Light, Dark, and "ODST" (Cyberpunk) themes.
*   **Cover Art**: High-resolution art extraction and intelligent background fetching.

### 2. ODST Downloader (Web UI)
A specialized tool for library expansion, accessible via `run.py`.
*   **Smart Matching**: Automatically finds the highest quality audio from YouTube "Topic" channels.
*   **Auto-Cloud Push**: Downloaded tracks can be automatically uploaded to your cloud storage and indexed into your library manifest.

### 3. Setup & Maintenance (CLI)
For power users who need advanced library operations:
*   **Library Janitor**: Verifies file integrity and prunes orphaned entries.
*   **The Surgeon**: Retroactively fixes metadata using MusicBrainz and ISRC lookups.
*   **Deep Scanner**: Indexes massive local directories without the need for uploading.

---

## Technical Architecture

*   **Database**: SQLite for high-speed indexing and instant search.
*   **Security**: All cloud credentials and sync tokens are encrypted on-disk.
*   **Privacy**: Zero telemetry. You own your data, and your metadata stays in your controlled cloud bucket.
*   **Efficiency**: Hash-based deduplication ensures you never store or upload the same track twice.

---

## Multi-Device Synchronization

To mirror your library on a new device:
1.  On your primary device, go to **Manage Storage > Config Management > Export Config**.
2.  On the new device, run `python3 run.py`, go to **Advanced**, and select **Import Config** using the generated token.

---

## Legal Disclaimer

Soundsible is for personal use only. Users are responsible for complying with local copyright laws and third-party Terms of Service.

## License

MIT License. See [LICENSE](LICENSE) for details.
