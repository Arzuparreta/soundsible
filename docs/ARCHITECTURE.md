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

- Accepts links or search queries (YouTube / YouTube Music).
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

## Request and playback flow

The typical path from a user action to audio playback looks like this:

1. A client (desktop or mobile browser / PWA) loads Station.
2. Station calls the Station Engine API over HTTP or keeps a WebSocket connection open for real‑time updates.
3. Station Engine queries `library.db` for metadata and search, and returns JSON responses.
4. When playback starts, Station requests an audio stream from the Station Engine.
5. Station Engine reads the file from the configured storage backend and streams audio bytes to the client.

For tracks that were downloaded via ODST, the file path and metadata are already registered in `library.db`, so they behave like any other library tracks.

## Library and metadata model (high‑level)

The SQLite database keeps the library structured but intentionally simple.

Conceptually, it tracks:

- Tracks (file path, title, duration, track‑level metadata, references to album/artist).
- Albums (name, artwork, year, references to artist).
- Artists (name and related metadata).
- Playlists (name and ordering of tracks).
- Search indices (FTS5 tables and helper indices) to support fast queries.

Audio files and artwork are not stored in the database. They live in the configured storage location, and rows in `library.db` point to them via normalized paths or URLs.

## Extensibility notes

At a high level, you can extend the system in the following places:

- Storage backends: add new storage providers by implementing the same path and URL contract the Station Engine expects, then wiring them into the setup wizard and configuration layer.
- Downloader behavior: adjust or extend ODST to support new sources or custom format selection, as long as it still produces a file and metadata entry the Station Engine understands.
- Frontend: build new views in Station that call the existing APIs, or add new endpoints in the Station Engine and then surface them in the UI.

For more details on configuration and deployment, see `CONFIGURATION.md` and `INSTALL.md`.

