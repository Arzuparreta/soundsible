## ARCHITECTURE – High‑level overview

Soundsible is composed of a backend “Station Engine”, a web UI (“Station”), a downloader (ODST), and storage + metadata infrastructure.

```text
Clients (desktop & mobile browsers / PWA)
        │
        ▼
   Station (web UI)
        │ HTTP / WebSocket
        ▼
   Station Engine (Flask backend)
        │
        ├── SQLite (library.db, FTS5)
        ├── Audio files (local disk / NAS / object storage)
        └── ODST downloader
```

### Backend – Station Engine

- **Tech**: Python + Flask.
- **Responsibilities**:
  - Scanning and indexing your music library.
  - Exposing APIs for search, playback, metadata editing, and configuration.
  - Streaming audio to the Station front‑end.
  - Coordinating downloads via the embedded ODST downloader.

### Database – SQLite

- Single `library.db` file for:
  - Track, album, artist, playlist metadata.
  - Full‑text search via FTS5.
  - Caches and indices to keep playback snappy.

### Frontend – Station

- **Tech**: vanilla JavaScript + Tailwind CSS.
- **Responsibilities**:
  - Library, playlists, favorites, and queue UI.
  - Discover/search screens (library + internet sources).
  - Embedded downloader controls.
  - Device‑adaptive layouts (desktop and mobile).

### Downloader – ODST

The ODST tool is available both as a separate component and tightly integrated into Station.

- Accepts links or search queries (YouTube / YouTube Music, and optionally Spotify‑based workflows).
- Resolves high‑quality audio sources.
- Downloads to a tracks directory using hashed filenames.
- Populates metadata so downloaded tracks immediately appear in the library.

See also: [`odst_tool/README.md`](../odst_tool/README.md).

### Storage

Audio and artwork can live on:

- Local filesystem on the host running Soundsible.
- Mounted NAS/shared storage.
- Cloud object storage backends (Cloudflare R2, Backblaze B2/R2, S2) when configured.

The setup wizard guides you through pointing Soundsible to the right storage location.

