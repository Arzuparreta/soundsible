# Soundsible: Technical Specification and System Documentation

Soundsible is a modular, high-fidelity media ecosystem designed for distributed audio management and hybrid streaming. It provides a unified interface for accessing music libraries across local filesystems (NAS), cloud object storage (S3, Cloudflare R2, Backblaze B2), and remote web clients with advanced network resilience.

## System Architecture

The project is built on an API-first methodology, decoupling the core logic and playback engine from the presentation layers.

### 1. Soundsible Core & Station API
The central intelligence of the system, implemented in Python.
- **Unified Station API (`shared/api.py`)**: A Flask-based REST service operating on **Port 5005**. It facilitates library synchronization, database queries, static file streaming, and hosts the integrated Downloader engine.
- **Smart Resolver Backend**: Automatically identifies all valid network interfaces (LAN, Tailscale) to broadcast to clients for seamless connectivity.
- **Library Manager (`player/library.py`)**: Handles the tri-fold resolution of audio sources (Local -> Cache -> Cloud) and manages the library manifest with automatic disk-to-memory synchronization.
- **Integrated Downloader (ODST)**: Now fully integrated into the Core API. Supports headless, multi-threaded background processing of Spotify and YouTube content directly to local/NAS storage.

### 2. Native Desktop Interfaces
- **Linux (GTK4/Adwaita)**: The reference implementation featuring tabbed album browsing, yellow "Favourite" indicators, and a dedicated QR hand-off generator.
- **Windows (Control Center)**: A dedicated Tkinter-based management dashboard for non-technical users. It provides visual configuration for NAS/Cloud storage and persists in the system tray.

### 3. Web Player (PWA) & Remote Station
A portable, touch-optimized frontend for Android, iOS, and Windows.
- **Tactile Interaction**: Features modern **Swipe Left to Delete** (with confirmation) and **Swipe Right to Favourite** (instant toggle) gestures optimized for mobile browsers.
- **Visual Parity**: Replicated the native desktop experience with yellow favourite indicators and high-resolution cover art extraction.
- **Remote Downloader**: A dedicated view for bulk-queueing URLs (multi-line support) and browsing Spotify playlists/liked songs from any device on the network.
- **Station Admin**: Direct remote control for "Library Optimization" and "Cloud Sync (R2/S3)" directly from the mobile interface.
- **Smart Resolver Engine**: Implements a "Connection Race" logic that pings multiple host addresses (LAN, Tailscale, Localhost) in parallel to lock onto the fastest available path.

## Key Features

- **Hybrid Streaming Model**: Direct cloud streaming with automatic local/NAS fallback.
- **Intelligent LRU Caching**: Automatic local caching of tracks with managed storage quotas.
- **Bulletproof Synchronization**: Real-time cross-client updates via Socket.IO and proactive "Refresh on Switch" tab logic.
- **Pro-Grade Metadata**: Automated enrichment using MusicBrainz and ISRC identification with embedded cover art extraction.
- **Persistent Station Queue**: Downloads continue on the main machine even if the remote browser is closed or disconnected.

## Installation and Deployment

### System Requirements
- Python 3.10+
- FFMPEG
- libmpv (for native Linux playback)

### Quick Start
```bash
python3 run.py
```
- **Windows**: Automatically launches the visual **Control Center**.
- **Linux**: Launches the **Interactive CLI Launcher**.

### Deployment Modes
- **Interactive**: Standard execution for local desktop use.
- **Daemon**: Run `python3 run.py --daemon` to host the Station as a background service for mobile access.
- **Automatic Cleanup**: The launcher includes a robust process-tracking system that ensures all background services on port 5005 are terminated upon exit.

## Connectivity and Networking

Soundsible operates primarily on:
- **Port 5005**: Unified Core API, Web Player, and Downloader.

### Mobile Connectivity & Tailscale
For the most stable experience, it is **strongly recommended** to use the **Tailscale IP** for mobile synchronization. 

- **Universal Access**: The Tailscale IP works both on your home Wi-Fi and on cellular data without any configuration changes.
- **Seamless Handoff**: Soundsible's "Smart Resolver" automatically detects and switches to the fastest path, but pinning the Tailscale IP ensures you never lose connection when leaving the house.
- **Security**: All traffic over Tailscale is end-to-end encrypted and requires no port forwarding.

## Legal Information

Soundsible is a technical framework for personal media management. Users are responsible for ensuring that their use of the software complies with local copyright regulations and the Terms of Service of third-party data providers.

## License

This project is licensed under the MIT License.
