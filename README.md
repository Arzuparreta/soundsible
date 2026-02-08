# Self-Hosted Music Hub

A cloud-first, self-hosted music platform that streams your own library from Cloudflare R2 / Backblaze B2 to any Linux device.

## Features

### Music Player 
- **Streaming playback**: Stream music directly from cloud storage 
- **Smart caching**: LRU cache with configurable size (default 50GB) 
- **Offline mode**: Play cached tracks without internet 
- **Multi-device sync**: Automatic library synchronization across devices 
- **GTK interface**: Native Linux desktop integration (GTK4/Adwaita) 
- **MPRIS integration**: Media key support (optional) 
- **Queue management**: Create and manage playback queues
- **Search/Filter**: In-app library search

### Setup Tool
- **Multi-provider support**: Choose between Cloudflare R2, Backblaze B2, or other S3-compatible services
- **Guided setup wizard**: Step-by-step account configuration and bucket creation
- **Automatic compression**: Convert lossless formats (FLAC/WAV) to MP3/OGG for efficient streaming
- **Deduplication**: Hash-based duplicate detection saves storage space
- **Parallel uploads**: Fast multi-threaded file uploads with progress tracking
- **QR code pairing**: Easy multi-device setup

## Architecture

```
┌──────────────────┐      ┌────────────────────┐      ┌─────────────────┐
│  Setup Tool CLI  │─────▶│  Cloud Storage     │◀─────│  Music Player   │
│  • Upload music  │      │  • Cloudflare R2   │      │  • Stream       │
│  • Auto-compress │      │  • Backblaze B2    │      │  • Cache        │
│  • Generate QR   │      │  • Generic S3      │      │  • Sync         │
└──────────────────┘      └────────────────────┘      └─────────────────┘
```

---

## Prerequisites

- Python 3.8 or higher
- ffmpeg (for audio conversion)
- **libmpv1** (required for music playback)
- **python-mpris-server** (optional, for media key support)

### System Packages

Install required system dependencies:

```bash
# Ubuntu/Debian
sudo apt install python3-pip python3-venv ffmpeg libmpv1 python3-gi gir1.2-gtk-4.0 gir1.2-adw-1

# Fedora
sudo dnf install python3-pip ffmpeg mpv-libs python3-gobject gtk4 libadwaita

# Arch
sudo pacman -S python-pip ffmpeg mpv python-gobject gtk4 libadwaita
```

---

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/sh-music-hub.git
   cd sh-music-hub
   ```

2. Create and activate virtual environment:
   ```bash
   python3 -m venv venv
   
   # Bash/Zsh users:
   source venv/bin/activate
   
   # Fish shell users:
   source venv/bin/activate.fish
   ```
   
   > **Note for Arch users:** Due to PEP 668, you must use a virtual environment for pip installations. Always activate the venv before installing Python packages.

3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

---

## Using the GUI App (Recommended)

The easiest way to use Music Hub is through the **GTK graphical application**:

```bash
./gui.sh
```

The GUI includes everything you need:
- 🎵 **Music Player** — Stream and play your library
- ⬇️ **Download & Push (Smart)** — Download music from Spotify/YouTube and upload to cloud *(Menu → Download & Push)*
- ⬆️ **Upload Local Files** — Upload local music files to cloud *(Menu → Upload Local Files)*
- ⚙️ **Setup Wizard** — Configure cloud storage credentials *(Menu → Setup Wizard)*
- 🎨 **Themes** — Choose between System, Light, Dark, or ODST themes

### First-Time Setup

On first launch, you'll be prompted to run the **Setup Wizard** to configure your cloud storage. This only needs to be done once.

### Optional: Enable Media Keys

For keyboard media control (play/pause/next/previous keys):

```bash
# Activate virtual environment first
source venv/bin/activate       # Bash/Zsh
source venv/bin/activate.fish  # Fish shell

# Then install MPRIS support
pip install mpris-server

# Or check AUR for system package (Arch users)
# yay -S python-mpris-server
```

---

## ODST Tool: Music Downloader

The **ODST Tool** is a dedicated web interface for downloading music from Spotify, YouTube, or YouTube Music links. It downloads music in sh-music-hub compatible format and can sync directly to your cloud storage.

To use the ODST Tool:

```bash
cd odst_tool
./downloader_web.sh
```

Then open the displayed URL in your browser to access the download interface.

> **Note:** This is different from the GUI's "Download & Push" feature. ODST provides more advanced features including multi-platform link support, playlist selection, smart matching, and batch downloads.

For detailed setup instructions (Spotify API credentials for auto-downloading playlists, etc.), see **[odst_tool/README.md](odst_tool/README.md)**.

---

## Alternative: Upload via Web Interface

For uploading local files to your cloud library through a web browser:

```bash
./start_web.sh
```

Then open the displayed URL (usually `http://localhost:5000`) in your browser.

---

## Advanced: CLI/Terminal Player

For terminal-based playback:

```bash
# List all tracks
./player.sh list

# Start interactive player (TUI)
./player.sh play

# Play matching tracks
./player.sh play "Daft Punk"

# Download tracks for offline use
./player.sh download "Jazz"

# Check cache usage
./player.sh cache-status
```

---

## Advanced: Setup Tool CLI

For advanced configuration and batch uploads via command line:

### Initial Setup

Run the guided setup wizard:
```bash
python -m setup_tool.cli init --guided
```

The wizard will:
1. Help you choose a storage provider (Cloudflare R2 or Backblaze B2)
2. Guide you through account creation
3. Configure API credentials
4. Create your music bucket
5. Generate player configuration

### Upload Music

Upload your music library:
```bash
python -m setup_tool.cli upload /path/to/your/music --compress --parallel 4
```

Options:
- `--compress`: Automatically convert FLAC/WAV to MP3 (320kbps)
- `--parallel N`: Number of concurrent uploads (default: 4)

### Check Status

View your library status:
```bash
python -m setup_tool.cli status
```

### Multi-Device Setup

Export configuration for other devices:
```bash
python -m setup_tool.cli export-config --format qr
```

Scan the QR code on your other device to automatically configure the player.

---

## Storage Provider Comparison

| Provider | Free Tier | Bandwidth Cost | Credit Card Required | Best For |
|----------|-----------|----------------|---------------------|----------|
| **Cloudflare R2** | 10GB | **$0** (zero egress) | Yes | Streaming (recommended) |
| **Backblaze B2** | 10GB | $0.01/GB | No | Simple setup, backups |
| **AWS S3** | 5GB (12 months) | $0.09/GB | Yes | AWS ecosystem users |

**Recommendation**: Use Cloudflare R2 for zero bandwidth costs when streaming music.

---

## Project Structure

```
sh-music-hub/
├── odst_tool/          # Spotify-to-YouTube downloader CLI
├── setup_tool/         # Upload and management CLI
│   ├── cli.py          # Command-line interface
│   ├── audio.py        # Audio processing
│   ├── storage_provider.py  # Abstract provider interface
│   ├── cloudflare_r2.py     # R2 implementation
│   └── backblaze_b2.py      # B2 implementation
├── player/             # GTK music player
├── shared/             # Shared utilities
│   ├── models.py       # Data models
│   ├── constants.py    # Constants
│   └── crypto.py       # Credential encryption
└── tests/              # Unit and integration tests
```

---

## Development Status

✅ **Phase 0: Foundation** (Complete)
- Project structure and virtual environment
- Data models and shared utilities
- S3 storage provider abstraction
- Cloudflare R2 and Backblaze B2 implementations
- Audio metadata extraction and compression

✅ **Phase 1: Setup Tool Core** (Complete)
- CLI interface with guided setup
- Parallel upload engine
- Configuration management

✅ **Phase 2-3: Upload Engine & Web Interface** (Complete)

✅ **Phase 4-6: Music Player** (Complete)

---

## Legal & Security

- **Content-agnostic**: This platform does not distribute copyrighted material
- **User responsibility**: Users must have rights to upload and stream their content
- **Credential security**: Cloud storage credentials are encrypted locally
- **Privacy**: No telemetry or data collection

## License

MIT License - See LICENSE file for details

## Contributing

Contributions welcome! Please read CONTRIBUTING.md first.

## Support

For issues and questions, please use GitHub Issues.
