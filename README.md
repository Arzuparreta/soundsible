# Soundsible: Universal Media Ecosystem

Soundsible is a professional-grade, cloud-native music platform designed for Linux. It enables users to stream their personal music collections from high-performance cloud storage (Cloudflare R2, Backblaze B2, or Generic S3) while maintaining a local-first experience through intelligent caching and native desktop integration.

## Core Components

The ecosystem consists of three primary modules integrated into a single unified launcher:

1.  **Music Player**: A high-fidelity GTK4/Adwaita application featuring gapless playback via the MPV engine, smart LRU caching, and MPRIS desktop integration.
2.  **ODST Downloader**: An Omni-Directional Search & Transfer tool capable of pulling high-quality audio from YouTube and Spotify, with automated metadata enrichment and cloud synchronization.
3.  **Setup & Maintenance Tool**: A comprehensive CLI suite for library management, cloud configuration, metadata harmonization, and multi-device synchronization via encrypted tokens or QR codes.

---

## Getting Started

This section provides a simplified installation path for users who want to get up and running quickly.

### 1. System Requirements

Ensure your Linux distribution has the following dependencies installed:

```bash
# Ubuntu / Debian / Pop!_OS
sudo apt install ffmpeg libmpv1 python3-gi gir1.2-gtk-4.0 gir1.2-adw-1 playerctl

# Fedora
sudo dnf install ffmpeg mpv-libs python3-gobject gtk4 libadwaita playerctl

# Arch Linux
sudo pacman -S ffmpeg mpv python-gobject gtk4 libadwaita playerctl
```

### 2. Installation

Clone the repository and run the automated launcher. The launcher will automatically handle virtual environment creation and dependency installation.

```bash
git clone https://github.com/Arzuparreta/soundsible.git
cd soundsible
python3 run.py
```

### 3. Initial Configuration

Upon the first execution, the **Setup Wizard** will appear. 
1.  Select **Run Setup / Settings** (Option 4).
2.  Follow the guided prompts to connect your cloud storage.
    *   **Recommended**: Cloudflare R2 for zero bandwidth egress fees.
    *   **Alternative**: Backblaze B2 for ease of setup without a credit card.
3.  Once configured, you can begin adding music to your library.

---

## Component Documentation

### The Music Player (GUI)

The primary interface for daily listening. Built with modern GNOME design principles.

*   **Streaming & Caching**: Streams directly from the cloud while simultaneously populating a local cache. This ensures that recently played tracks remain available during internet outages.
*   **Universal Sync**: Implements a 3-way merge algorithm to synchronize library manifests across all your devices.
*   **Dynamic UI**: Supports Light, Dark, and specialized ODST themes. Features a marquee-style scrolling title for long track names and high-resolution cover art extraction.
*   **Media Keys**: Supports standard keyboard playback controls and desktop-wide media widgets via MPRIS.

### ODST Music Downloader

A specialized tool for expanding your library from external sources.

*   **Web Interface**: Access via `run.py` (Option 2) to manage downloads through a clean browser UI.
*   **Multi-Source Support**: Accepts direct links from Spotify, YouTube, and YouTube Music.
*   **Smart Matching**: Prioritizes YouTube "Topic" channels to ensure the highest available audio quality and official metadata.
*   **Auto-Cloud Sync**: Can be configured to automatically push downloaded tracks to your cloud storage and update the global library manifest.

### Setup & Maintenance CLI

A powerful toolset for advanced library operations. Accessible via `python -m setup_tool.cli`.

*   **Library Janitor**: `cleanup` — Prunes orphaned entries and verifies the integrity of both local and cloud files.
*   **The Surgeon**: `refresh-metadata` — Retroactively fixes metadata by identifying tracks via MusicBrainz and ISRC codes to pull "Gold Standard" tags (Album, Year, Track Number).
*   **Deep Scanner**: `scan` — Indexes large local directories (e.g., a NAS) without uploading them, allowing local files to be treated as part of the unified library.
*   **Batch Fixer**: `fix-library-covers` — Downloads missing artwork, embeds it directly into audio tags, and re-uploads files to ensure permanent cover art persistence.
*   **Service Integration**: `install-service` — Installs Soundsible as a systemd user service to enable background folder watching and API availability.

---

## Technical Architecture

Soundsible is designed for robustness and privacy:

*   **Database**: Utilizes SQLite for high-speed local searching and metadata indexing.
*   **Security**: All cloud credentials are encrypted on-disk using industry-standard cryptography.
*   **Privacy**: Zero telemetry or external data collection. Your library metadata remains in your controlled cloud bucket.
*   **Storage Efficiency**: Implements hash-based deduplication to prevent duplicate uploads and save storage costs.

---

## Multi-Device Synchronization

To sync your library to a new device:
1.  On the primary device, run `setup-tool export-config`.
2.  Scan the generated **QR Code** or copy the **Encrypted Token**.
3.  On the new device, use `setup-tool import-config <token>` to instantly mirror your entire ecosystem.

---

## Legal Disclaimer

Soundsible is provided for personal, educational, and research purposes only. Users are solely responsible for ensuring they have the legal right to download, upload, or stream any content accessed through this software. The authors assume no liability for misuse of this tool or violations of third-party Terms of Service.

---

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
