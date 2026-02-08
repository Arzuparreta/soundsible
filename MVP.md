# Soundsible - MVP Feature Set

## Version: MVP v1.0
**Date:** 2026-01-13

This document captures the complete feature set of the Soundsible MVP.

---

## Core Features

### 🎵 Music Playback
- MPV-based playback engine
- Play/pause controls
- Progress bar with seek functionality
- Volume knob (circular widget)
- MPRIS integration (media keys support)

### 🎨 Cover Art Display
- Embedded cover art extraction from audio files
- 48x48 cover art in player controls (shows when playing)
- Clickable cover art opens mini-player (350x385)
- Mini-player features:
  - Large album art display
  - Play/pause button
  - Volume slider
  - Close button (bottom left)
  - ESC to close
- 32x32 thumbnails in library view

### 📚 Library Management
- Track list view with columns: Cover, Title, Artist, Album, Length
- Cloud storage sync (Cloudflare R2 / Backblaze B2)
- Local caching for offline playback
- Background track downloading
- Right-click to edit metadata/cover art

### 🔍 Search & Filter
- Search bar at bottom of window
- Live filtering by title, artist, or album
- Case-insensitive partial matching
- ESC to unfocus search bar

### ⚙️ Settings Panel
Access via menu button (⋮) in header

**Storage Tab:**
- Provider and bucket name display
- Cloud storage calculator (S3 API-based)
- Local cache size display
- Clear cache button with confirmation

**Playback Tab:**
- Audio output device info

**Appearance Tab:**
- Color scheme selector (System/Light/Dark) - live switching
- Font size selector (Small/Normal/Large)

### 🎼 Metadata Editing
- Edit track title, artist, album
- Auto-fetch cover art from online sources
- Upload local cover art files
- Automatically re-uploads modified tracks
- Cache invalidation on update

### ☁️ Cloud Storage
- S3-compatible storage (Cloudflare R2 / Backblaze B2)
- Automatic library sync
- Bucket size calculation
- Track upload via setup wizard

---

## UI/UX Details

### Layout (Top to Bottom)
1. Header bar with title and menu
2. Player controls (cover, track info, play, progress, volume)
3. Library view (scrollable track list)
4. Search bar

### Interactions
- Double-click track to play
- Click cover art for mini-player
- Right-click track for edit menu
- ESC unfocuses search bar
- Click library area unfocuses search bar

### Visual Polish
- Cover art hidden when idle
- Labels empty when no track playing
- Dynamic spacing based on content
- Adwaita design language
- GTK4 modern UI

---

## Technical Stack

### Frontend
- GTK4 + Libadwaita
- Python 3.x
- Cairo (for custom volume knob)

### Backend
- MPV (playback)
- Mutagen (metadata & cover art)
- boto3 (S3 storage)
- MPRIS (media keys)

### Storage
- Cloud: S3-compatible (Cloudflare R2 / Backblaze B2)
- Local: LRU cache for audio files
- Config: JSON in `~/.config/music-hub/`

---

## File Structure

```
player/
├── engine.py          # MPV playback engine
├── library.py         # Library management
└── ui/
    ├── main.py        # Main window
    ├── library.py     # Library view
    ├── volume_knob.py # Custom volume widget
    └── settings.py    # Settings dialog

setup_tool/
├── storage_provider.py  # S3 storage abstraction
├── cloudflare_r2.py     # Cloudflare R2 provider
├── backblaze_b2.py      # Backblaze B2 provider
└── audio.py             # Audio processing & metadata

shared/
├── models.py       # Data models
└── constants.py    # Configuration constants
```

---

## Known Limitations

1. Storage usage requires manual calculation (button click)
2. Font size changes require app restart
3. No playlist support yet
4. No queue management yet
5. No keyboard shortcuts (except ESC for search)

---

## Future Enhancements (Post-MVP)

- Playlist management
- Queue system with shuffle/repeat
- Lyrics display
- Equalizer
- Statistics & play history
- Keyboard shortcuts
- Import from local folders
- Export playlists

---

## Running the MVP

```bash
./gui.sh
```

**First time setup:**
1. Run setup wizard (appears automatically)
2. Configure storage provider
3. Upload music or sync existing library

---

**This MVP represents a fully functional, self-hosted music player with cloud storage integration.**
