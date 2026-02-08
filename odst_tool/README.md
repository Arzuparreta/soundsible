# Music Downloader (ODST Tool)

A powerful tool to download music from YouTube Music, YouTube, or Spotify links. Fully compatible with `sh-music-hub`.

## Features
- **Flexible Selection**: Download everything, specific playlists, or liked songs
- **Smart Search**: Uses YouTube "Topic" channels for highest quality audio
- **Multi-Platform Links**: Paste links from Spotify, YouTube, or YouTube Music (can mix sources!)
- **Storage**: Stores files as `tracks/{hash}.mp3` with `library.json` metadata (sh-music-hub compatible)
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

### Web App (Recommended)

The easiest way to download music is through the web interface:

```bash
./downloader_web.sh
```

Then open the displayed URL in your browser. Paste music links (one per line) from:
- Spotify
- YouTube  
- YouTube Music

You can mix links from different platforms in the same batch!

> **Note:** Spotify API credentials are **only needed** if you want to auto-download your entire Spotify library/playlists. For simply pasting links, no credentials are required.

---

### CLI Helper Script

**Run via Helper Script:**
```bash
./run.sh --help
```

### Examples

**Download Everything (Liked + Playlists + Albums):**
```bash
./run.sh --source all
```

**Interactive Playlist Selection:**
```bash
./run.sh --source playlists --interactive
```

**Download Specific Playlist:**
```bash
./run.sh --source playlist --playlist-name "My Workout Mix"
```

**Advanced Usage:**
```bash
./run.sh --output ~/Music/MyLibrary --workers 8
```
