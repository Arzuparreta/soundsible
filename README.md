# Self-Hosted Music Hub

A cloud-first, self-hosted music platform that streams your own library from Cloudflare R2 / Backblaze B2 to any Linux device.

## 🚀 Quick Start Cheatsheet

### 1. Setup (Run once)
```bash
# Install system dependency
sudo apt install libmpv1

# Setup credentials & create bucket
python -m setup_tool init --guided
```

### 2. Manage Library
```bash
# Web Interface (Easiest Method)
./start_web.sh

# CLI Upload (Advanced)
python -m setup_tool upload ~/Music --parallel 4
```

### 3. Play Music
```bash
# List all tracks
./player.sh list

# Start Player (TUI)
./player.sh play

# Play match
./player.sh play "Daft Punk"
```

### 4. Offline / Downloads
```bash
# Download tracks for offline use
./player.sh download "Jazz"

# Check cache usage
./player.sh cache-status
```

---

## Features

### Setup Tool
- **Multi-provider support**: Choose between Cloudflare R2, Backblaze B2, or other S3-compatible services
- **Guided setup wizard**: Step-by-step account configuration and bucket creation
- **Automatic compression**: Convert lossless formats (FLAC/WAV) to MP3/OGG for efficient streaming
- **Deduplication**: Hash-based duplicate detection saves storage space
- **Parallel uploads**: Fast multi-threaded file uploads with progress tracking
- **QR code pairing**: Easy multi-device setup

### Music Player (Coming in Phase 4-6)
- **Streaming playback**: Stream music directly from cloud storage
- **Smart caching**: LRU cache with configurable size (default 50GB)
- **Offline mode**: Play cached tracks without internet
- **Multi-device sync**: Automatic library synchronization across devices
- **GTK interface**: Native Linux desktop integration

## Architecture

```
┌──────────────────┐      ┌────────────────────┐      ┌─────────────────┐
│  Setup Tool CLI  │─────▶│  Cloud Storage     │◀─────│  Music Player   │
│  • Upload music  │      │  • Cloudflare R2   │      │  • Stream       │
│  • Auto-compress │      │  • Backblaze B2    │      │  • Cache        │
│  • Generate QR   │      │  • Generic S3      │      │  • Sync         │
└──────────────────┘      └────────────────────┘      └─────────────────┘
```

## Installation

### Prerequisites

- Python 3.8 or higher
- ffmpeg (for audio conversion)
- System packages:
  ```bash
  # Ubuntu/Debian
  sudo apt install python3-pip python3-venv ffmpeg
  
  # Fedora
  sudo dnf install python3-pip ffmpeg
  
  # Arch
  sudo pacman -S python-pip ffmpeg
  ```

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/sh-music-hub.git
   cd sh-music-hub
   ```

2. Create and activate virtual environment:
   ```bash
   python3 -m venv venv
   source venv/bin/activate  # Linux/Mac
   # or
   venv\Scripts\activate  # Windows
   ```

3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

## Usage

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

## Storage Provider Comparison

| Provider | Free Tier | Bandwidth Cost | Credit Card Required | Best For |
|----------|-----------|----------------|---------------------|----------|
| **Cloudflare R2** | 10GB | **$0** (zero egress) | Yes | Streaming (recommended) |
| **Backblaze B2** | 10GB | $0.01/GB | No | Simple setup, backups |
| **AWS S3** | 5GB (12 months) | $0.09/GB | Yes | AWS ecosystem users |

**Recommendation**: Use Cloudflare R2 for zero bandwidth costs when streaming music.

## Project Structure

```
sh-music-hub/
├── setup-tool/          # Upload and management CLI
│   ├── cli.py          # Command-line interface
│   ├── audio.py        # Audio processing
│   ├── storage_provider.py  # Abstract provider interface
│   ├── cloudflare_r2.py     # R2 implementation
│   └── backblaze_b2.py      # B2 implementation
├── player/             # GTK music player (Phase 4-6)
├── shared/             # Shared utilities
│   ├── models.py       # Data models
│   ├── constants.py    # Constants
│   └── crypto.py       # Credential encryption
└── tests/              # Unit and integration tests
```

## Development Status

✅ **Phase 0: Foundation** (Complete)
- Project structure and virtual environment
- Data models and shared utilities
- S3 storage provider abstraction
- Cloudflare R2 and Backblaze B2 implementations
- Audio metadata extraction and compression

🚧 **Phase 1: Setup Tool Core** (In Progress)
- CLI interface with guided setup
- Parallel upload engine
- Configuration management

📋 **Phase 2-3: Upload Engine & Web Interface** (Planned)

📋 **Phase 4-6: Music Player** (Planned)

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