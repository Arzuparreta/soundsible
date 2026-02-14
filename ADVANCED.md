# Soundsible: Advanced Technical Specifications

This document provides detailed architectural and system documentation for the Soundsible media ecosystem.

## System Architecture

Soundsible is built on an API-first methodology, decoupling the core logic and playback engine from the presentation layers.

### 1. Soundsible Core & Station API
The central intelligence of the system, implemented in Python.
- **Unified Station API (`shared/api.py`)**: A Flask-based REST service operating on **Port 5005**. It facilitates library synchronization, database queries, and static file streaming via HTTP 206 (Partial Content).
- **Socket.IO Integration**: Provides real-time bidirectional communication for background download logs and cross-client library updates.
- **Smart Resolver Backend**: Automatically identifies all valid network interfaces (LAN, Tailscale) to broadcast to clients for seamless connectivity.
- **Library Manager (`player/library.py`)**: Handles the tri-fold resolution of audio sources (Local -> Cache -> Cloud) and manages the library manifest with automatic disk-to-memory synchronization.
- **Security Layer (`shared/crypto.py`)**: Implements machine-specific Fernet encryption for cloud credentials and synchronization tokens.

### 2. Integrated Downloader (ODST Engine)
A headless, multi-threaded processor integrated directly into the Core API.
- **Persistent Queue**: Maintains an active task list that continues processing on the main machine even if remote clients disconnect.
- **Auth Logic**: Dynamic credential priority (Access Token > Client ID > Skip) ensuring non-blocking initialization in headless environments.
- **NAS Optimization**: Passive storage access logic designed to prevent uninterruptible kernel waits on Samba/network mounts.

### 3. Web Player (PWA) Architecture
A portable, touch-optimized frontend built with vanilla ES6+ JavaScript and Tailwind CSS.
- **Smart Resolver Engine**: Implements a "Connection Race" logic that pings multiple host addresses in parallel to lock onto the fastest available path.
- **State Management**: Lightweight local storage synchronization with proactive "Refresh on Switch" tab logic to ensure zero-lag synchronization.

## Deployment and Operations

### Deployment Modes
- **Standard**: Launched via `python3 run.py`. Automatically detects the host OS to launch the appropriate UI (GTK on Linux, Control Center on Windows).
- **Daemon Mode**: Run `python3 run.py --daemon` to host the Station as a background service. This mode is optimized for dedicated "Home Station" servers.
- **Process Management**: The launcher includes a robust tracking system that ensures all background services on port 5005 are terminated cleanly upon exit.

### Network Specifications
- **API Port**: 5005 (Fixed)
- **Streaming**: Supports HTTP Range headers for efficient mobile data usage and seeking.
- **Discovery**: Relies on host-level interface reporting and Tailscale API integration.

## Legal Information

Soundsible is a technical framework for personal media management. Users are responsible for ensuring that their use of the software complies with local copyright regulations and the Terms of Service of third-party data providers.

## License

This project is licensed under the MIT License.
