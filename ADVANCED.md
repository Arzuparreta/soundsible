# Soundsible: Advanced Technical Documentation

This document details the internal architecture, data flow, and service specifications of the Soundsible media ecosystem.

## 🏗 System Architecture

Soundsible is built on an **API-First, Hybrid-Storage** model.

### 1. Unified Station API (`shared/api.py`)
The central hub of the ecosystem, running on **Flask** and **Socket.IO**.
- **Port**: 5005
- **Streaming**: Implements HTTP Range headers (206 Partial Content) for efficient seeking and mobile data conservation.
- **Real-time Engine**: Uses WebSockets to stream background download logs and broadcast library updates across all connected clients.
- **Smart Discovery**: Automatically probes all host network interfaces to provide valid endpoints to clients.

### 2. Storage & Resolution Logic
Soundsible uses a **Tri-Fold Resolution** strategy for every track:
1.  **Local**: Checks if the file exists on the local machine's filesystem (indexed via Deep Scan).
2.  **Cache**: Checks the local LRU cache (`~/.cache/soundsible/`).
3.  **Cloud**: Requests a signed URL from the configured provider (R2, B2, S3).

### 3. Integrated Downloader (ODST Core)
The background processing engine for library expansion.
- **Threaded Execution**: Managed by a dedicated background thread in the API to prevent blocking user requests.
- **Queue Management**: Non-persistent, memory-buffered task list.
- **Metadata Harmonization**: Automatically standardizes metadata using **MusicBrainz** and **ISRC** lookups to ensure library consistency.
- **NAS-Friendly I/O**: Designed with non-blocking checks to avoid kernel-level stalls on stale Samba mounts.

### 4. Database & Indexing (`shared/database.py`)
- **Engine**: SQLite 3 with **FTS5** (Full-Text Search) enabled.
- **Synchronization**: Automatically reloads memory metadata if the `library.json` manifest on disk is modified by external processes (e.g., the GTK app).
- **Schema**: Atomically tracks file hashes, metadata, local paths, and cloud keys.

## 🔒 Security & Encryption
- **Credential Management**: Uses machine-specific **Fernet symmetric encryption**. Credentials stored in `config.json` are unreadable without the unique machine key.
- **Sync Tokens**: Multi-device pairing is handled via compressed, base64-encoded JSON blobs containing encrypted endpoints.

## 🛠 Operations & CLI
The `setup_tool` provides low-level maintenance commands:
- `upload`: Parallel upload with optional MP3 compression.
- `cleanup`: Prunes orphans from the database where files no longer exist in any source.
- `fix_library_covers`: Retroactively embeds high-resolution artwork into file tags and re-uploads to the cloud.
- `refresh_metadata`: Forces a re-identification of the entire library against global metadata standards.

## 📱 Web Station (PWA)
- **Tech Stack**: Vanilla ES6+ JS, Tailwind CSS, Service Workers.
- **State Management**: Reactive state store with proactive "Refresh on Switch" tab logic to ensure zero-lag synchronization across devices.
- **PWA Capabilities**: Fully installable on iOS and Android with offline-ready manifest support.

---

## ⚖️ Legal Disclaimer
Soundsible is a technical framework for personal media management. Users are responsible for ensuring that their use of the software complies with local copyright regulations and the Terms of Service of third-party data providers.
