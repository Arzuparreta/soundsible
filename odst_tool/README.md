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

1. **Install Dependencies**
   ```bash
   chmod +x setup_env.sh
   ./setup_env.sh
   ```
   *(Or manually: `python -m venv venv && ./venv/bin/pip install -r requirements.txt`)*

2. **Optional**: Create a `.env` file (e.g. from `odst_tool/.env.example`) to override `OUTPUT_DIR` or other options.

## Usage

### Web (embedded)

Use the **main Soundsible webapp**: start the API (e.g. from `run.py` → Launch Web Player), then open `http://localhost:5005/player/`. The downloader is built into the player UI.

### Desktop GUI (legacy)

```bash
./downloader_gui.sh
```
Requires tkinter. If tkinter is missing, use the embedded downloader in the webapp instead.
