# Soundsible: Advanced Technical Documentation

This document details the internal architecture, data flow, and service specifications of the Soundsible media ecosystem.

## 🏗 System Architecture

Soundsible is built on an **API-First, Hybrid-Storage** model, now featuring a state-driven mobile interaction engine.

### 1. Unified Station API (`shared/api.py`)
The central hub of the ecosystem, running on **Flask** and **Socket.IO**.
- **Port**: 5005
- **Streaming**: Implements HTTP Range headers (206 Partial Content) for efficient seeking and mobile data conservation.
- **Real-time Engine**: Uses WebSockets to stream background download logs and broadcast library updates across all connected clients.
- **Connection Race**: Clients perform simultaneous pings to Local, Tailscale, and Cloud paths, locking the WebSocket to the fastest interface.

### 2. Omni-Island Interaction Engine
The flagship UI component utilizes a custom state machine for adaptive sizing and gesture orchestration.
- **Adaptive States**: 
    - **Seed**: 56px circular button.
    - **Active**: 286px playback capsule.
    - **Bloom**: 380px navigation grid.
- **Touch Coordinate Logic**: Uses X-coordinate math to divide the capsule into technical zones (Prev < 35%, Anchor 35-65%, Next > 65%).
- **Safe Release System**: All transport commands are validated on `touchend` against the capsule's current `getBoundingClientRect()` to support drag-to-cancel.
- **Physics**: Transitions standardized to 0.5s-0.6s using the "Premium Slime" curve (`0.19, 1, 0.22, 1`).

### 3. Storage & Resolution Logic
Soundsible uses a **Tri-Fold Resolution** strategy for every track:
1.  **Local**: Checks if the file exists on the local machine's filesystem (indexed via Deep Scan).
2.  **Cache**: Checks the local LRU cache (`~/.cache/soundsible/`).
3.  **Cloud**: Requests a signed URL from the configured provider (R2, B2, S3).

### 4. Integrated Downloader (ODST Core)
The background processing engine for library expansion.
- **Metadata Surgeon**: Implements technical marquee scrollers and high-fidelity cover art synchronization.
- **Metadata Harmonization**: Automatically standardizes metadata using **MusicBrainz** and **ISRC** lookups.

### 5. Database & Indexing (`shared/database.py`)
- **Engine**: SQLite 3 with **FTS5** (Full-Text Search) enabled.
- **Synchronization**: Automatically reloads memory metadata if the `library.json` manifest on disk is modified.

## 🔒 Security & Encryption
- **Credential Management**: Uses machine-specific **Fernet symmetric encryption**. 
- **Sync Tokens**: Multi-device pairing is handled via compressed, base64-encoded JSON blobs containing encrypted endpoints.

## 📱 Web Station (PWA)
- **State Management**: Reactive state store with proactive "Refresh on Switch" logic.
- **Gestures**: Implements a 14% height threshold for sheet dismissal and 60px edge-zones for navigation triggers.
- **Optimization**: Global `user-select: none`, `touch-action: pan-y`, and hardware-accelerated transforms for 60fps performance on mobile.

---

## ⚖️ Legal Disclaimer
Soundsible is a technical framework for personal media management. Users are responsible for ensuring that their use of the software complies with local copyright regulations and the Terms of Service of third-party data providers.
