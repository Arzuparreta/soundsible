# Spotify to YouTube Downloader 🎵

A powerful tool to download your Spotify library by finding the best matches on YouTube. Fully compatible with `sh-music-hub`.

## Features
- 📥 **Flexible Selection**: Download everything, specific playlists, or liked songs.
- 🔍 **Smart Search**: Uses YouTube "Topic" channels for highest quality audio.
- 💾 **Storage**: Stores files as `tracks/{hash}.mp3` with `library.json` metadata (sh-music-hub compatible).
- 🏷️ **Metadata**: Embeds ID3 tags and Album Art from Spotify.
- 🚀 **Parallel Downloads**: Fast multi-threaded processing.

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
