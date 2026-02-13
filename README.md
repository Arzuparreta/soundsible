# Soundsible: Technical Specification and System Documentation

Soundsible is a modular, high-fidelity media ecosystem designed for distributed audio management and hybrid streaming. It provides a unified interface for accessing music libraries across local filesystems (NAS), cloud object storage (S3, Cloudflare R2, Backblaze B2), and remote web clients.

## System Architecture

The project is built on an API-first methodology, decoupling the core logic and playback engine from the presentation layers.

### 1. Soundsible Core (Backend)
The central intelligence of the system, implemented in Python.
- **Core API (`shared/api.py`)**: A Flask-based REST service that facilitates library synchronization, database queries, and static file streaming via HTTP 206 (Partial Content) for seeking support.
- **Library Manager (`player/library.py`)**: Handles the tri-fold resolution of audio sources (Local -> Cache -> Cloud) and manages the library manifest.
- **Database Engine (`shared/database.py`)**: Utilizes SQLite for high-performance metadata indexing and full-text search capabilities.
- **Security Layer (`shared/crypto.py`)**: Implements machine-specific Fernet encryption for cloud credentials and synchronization tokens.

### 2. Native Desktop Interface (Linux)
The reference implementation for high-fidelity desktop playback.
- **Technology Stack**: GTK4, Libadwaita, and Python-GObject.
- **Playback Engine**: Integration with `libmpv` for gapless, low-latency audio processing.
- **Feature Set**: Tabbed album browsing, dynamic search, and an integrated QR generator for mobile device hand-off.

### 3. Web Player (PWA)
A portable, touch-optimized frontend for Android, iOS, and Windows.
- **Technology Stack**: Vanilla JavaScript (ES6+), Tailwind CSS, and Service Workers.
- **Offline Capability**: Implementation of a persistent caching layer via the Service Worker API, mirroring the desktop LRU caching logic.
- **Responsive UX**: A unified interaction layer supporting swipe gestures, long-press context menus, and adaptive layouts for mobile and desktop browsers.

### 4. Operations & Maintenance Tools
- **ODST Tool**: A specialized web-based utility for library expansion, supporting Spotify and YouTube metadata resolution and automated cloud ingestion.
- **Setup Tool**: A multi-mode interface (CLI and Web) for initial cloud configuration, massive library scanning, and metadata harmonization.

## Key Features

- **Hybrid Streaming Model**: Direct streaming from cloud providers with automatic fallback to local NAS paths if the client is within the local area network (LAN).
- **Intelligent LRU Caching**: Tracks are cached locally upon playback. The system manages storage quotas automatically to ensure offline availability without exhausting device storage.
- **Encrypted Synchronization**: Devices are linked via Zlib-compressed, base64-encoded tokens that transmit library configurations securely over LAN or Tailscale networks.
- **Pro-Grade Metadata**: Automated enrichment of track data using MusicBrainz and ISRC identification.

## Installation and Deployment

### System Dependencies
The system requires the following runtime environments:
- Python 3.10+
- FFMPEG (for format normalization)
- libmpv (for native Linux playback)
- GTK4 and Libadwaita (for desktop UI)

### Environment Setup
The system utilizes a self-bootstrapping launcher:
```bash
python3 run.py
```
The launcher manages virtual environment creation, dependency installation, and background service lifecycle.

## Connectivity and Networking

Soundsible is designed to operate in complex network environments, supporting:
- **Local Area Network (LAN)**: Direct device-to-device communication over standard Wi-Fi.
- **Tailscale Integration**: Automatic detection and support for Tailscale IPs, allowing secure remote access without port forwarding.
- **Firewall Configuration**: The system operates primarily on port 5005 (Core API/Web Player) and port 5000 (Operations Tools).

## Deployment Modes

- **Interactive Mode**: Standard execution for local desktop use.
- **Daemon Mode**: Run `python3 run.py --daemon` to host the Core API and Web Player as a background service, ideal for dedicated media servers or NAS installations.

## Legal Information

Soundsible is a technical framework for personal media management. Users are responsible for ensuring that their use of the software complies with local copyright regulations and the Terms of Service of third-party data providers.

## License

This project is licensed under the MIT License.
