# Music Downloader (ODST Tool)

A powerful tool to download music from YouTube Music and YouTube links. Fully compatible with `Soundsible`.

> [!WARNING]
> **ODST and Soundsible do not encourage or support piracy or Terms‑of‑Service violations.**  
> Use this tool only with content you have the legal right to access and in compliance with all applicable laws and platform terms.  
> See the main project’s [docs/LEGAL.md](../docs/LEGAL.md) for full legal and acceptable‑use details.

**The downloader is now embedded in the main Soundsible webapp.** Use the web player at `http://localhost:5005/player/` (ensure the API is running on port 5005) for the built-in downloader.

## Features
- **Flexible Selection**: Download everything, specific playlists, or liked songs
- **Smart Search**: Uses YouTube "Topic" channels for highest quality audio
- **YouTube / YouTube Music**: Paste links or search by song name
- **Storage**: Stores files as `tracks/{hash}.mp3` with `library.json` metadata (Soundsible compatible)
- **Metadata**: Embeds ID3 tags and album art from resolved sources
- **Parallel Downloads**: Fast multi-threaded processing

## Setup

Dependencies come from the project's root `requirements.txt` — this package is
imported by the engine, not installed on its own.

**Optional**: create a `.env` file (e.g. from `odst_tool/.env.example`) to override `OUTPUT_DIR` or other options.

## Usage

Use the **main Soundsible webapp**: start the API (e.g. from `run.py` → Launch Web Player), then open `http://localhost:5005/player/`. The downloader is built into the player UI (Search and **Discover**; Discover uses Deezer for browsing only, then the same YouTube search path to queue downloads — see `docs/ARCHITECTURE.md`).

The standalone tkinter GUI and its `setup_env.sh` / `downloader_gui.sh` helpers
were removed; the embedded downloader replaces them.
