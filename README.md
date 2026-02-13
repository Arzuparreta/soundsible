# Soundsible: Technical Specification and System Documentation

Soundsible is a modular, high-fidelity media ecosystem designed for distributed audio management and hybrid streaming. It provides a unified interface for accessing music libraries across local filesystems (NAS), cloud object storage (S3, Cloudflare R2, Backblaze B2), and remote web clients with advanced network resilience.

## System Architecture

The project is built on an API-first methodology, decoupling the core logic and playback engine from the presentation layers.

### 1. Soundsible Core (Backend)
The central intelligence of the system, implemented in Python.
- **Core API (`shared/api.py`)**: A Flask-based REST service that facilitates library synchronization, database queries, and static file streaming via HTTP 206 (Partial Content).
- **Smart Resolver Backend**: Automatically identifies all valid network interfaces (LAN, Tailscale) to broadcast to clients for seamless connectivity.
- **Library Manager (`player/library.py`)**: Handles the tri-fold resolution of audio sources (Local -> Cache -> Cloud) and manages the library manifest.
- **Security Layer (`shared/crypto.py`)**: Implements machine-specific Fernet encryption for cloud credentials and synchronization tokens, supporting both Linux and Windows environments.

### 2. Native Desktop Interfaces
- **Linux (GTK4/Adwaita)**: The reference implementation featuring tabbed album browsing and a dedicated QR hand-off generator.
- **Windows (Control Center)**: A dedicated Tkinter-based management dashboard for non-technical users. It provides visual configuration for NAS/Cloud storage and persists in the system tray.

### 3. Web Player (PWA) & Smart Resolver
A portable, touch-optimized frontend for Android, iOS, and Windows.
- **Technology Stack**: Vanilla JavaScript (ES6+), Tailwind CSS, and Service Workers.
- **Smart Resolver Engine**: Implements a "Connection Race" logic that pings multiple host addresses (LAN, Tailscale, Localhost) in parallel to lock onto the fastest available path.
- **Universal Connectivity**: Prioritizes Tailscale for seamless Wi-Fi-to-LTE transitions without session interruption.
- **Connection Refiner**: A manual fallback interface for updating the host IP without re-importing the full sync token.

## Key Features

- **Hybrid Streaming Model**: Direct cloud streaming with automatic LAN fallback.
- **Intelligent LRU Caching**: Automatic local caching of tracks with managed storage quotas.
- **Encrypted Synchronization**: Base64-encoded, compressed tokens for secure multi-device pairing.
- **Pro-Grade Metadata**: Automated enrichment using MusicBrainz and ISRC identification.
- **Integrated Downloader**: Direct access to the ODST tool for library expansion via YouTube and Spotify.

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
- **Automatic Cleanup**: The launcher includes a robust process-tracking system that ensures all background API and player services are terminated upon exit.

## Connectivity and Networking

Soundsible operates primarily on:
- **Port 5005**: Core API & Web Player.
- **Port 5000**: ODST Operations Tools.

### Mobile Connectivity & Tailscale
For the most stable experience, it is **strongly recommended** to use the **Tailscale IP** for mobile synchronization. 

- **Universal Access**: The Tailscale IP works both on your home Wi-Fi and on cellular data without any configuration changes.
- **Seamless Handoff**: Soundsible's "Smart Resolver" automatically detects and switches to the fastest path, but pinning the Tailscale IP ensures you never lose connection when leaving the house.
- **Security**: All traffic over Tailscale is end-to-end encrypted and requires no port forwarding.

If you are not using Tailscale, use the **Local IP** only when your mobile device is on the same Wi-Fi network as the host Station.

## Legal Information

Soundsible is a technical framework for personal media management. Users are responsible for ensuring that their use of the software complies with local copyright regulations and the Terms of Service of third-party data providers.

## License

This project is licensed under the MIT License.
