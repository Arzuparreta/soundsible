# Music Downloader (ODST Tool)

A powerful tool to download music from YouTube Music, YouTube, or Spotify links. Fully compatible with `Soundsible`.

**The downloader is now embedded in the main Soundsible webapp.** Use the web player at `http://localhost:5005/player/` (ensure the API is running on port 5005) for the built-in downloader.

## Features
- **Flexible Selection**: Download everything, specific playlists, or liked songs
- **Smart Search**: Uses YouTube "Topic" channels for highest quality audio
- **Multi-Platform Links**: Paste links from Spotify, YouTube, or YouTube Music (can mix sources!)
- **Storage**: Stores files as `tracks/{hash}.mp3` with `library.json` metadata (Soundsible compatible)
- **Metadata**: Embeds ID3 tags and Album Art from Spotify
- **Parallel Downloads**: Fast multi-threaded processing

## Setup

1. **Install Dependencies**
   ```bash
   chmod +x setup_env.sh
   ./setup_env.sh
   ```
   *(Or manually: `python -m venv venv && ./venv/bin/pip install -r requirements.txt`)*

2. **Configure Credentials**
   Create a `.env` file with your Spotify App credentials:
   ```bash
   cp .env.example .env
   nano .env
   ```
   *Get credentials at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)*

## Usage

### Web (embedded)

Use the **main Soundsible webapp**: start the API (e.g. from `run.py` → Launch Web Player), then open `http://localhost:5005/player/`. The downloader is built into the player UI.

### Desktop GUI (legacy)

```bash
./downloader_gui.sh
```
Requires tkinter. If tkinter is missing, use the embedded downloader in the webapp instead.

> **Note:** Spotify API credentials are **only needed** if you want to auto-download your entire Spotify library/playlists. For simply pasting links, no credentials are required.
