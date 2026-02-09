# Soundsible

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
sudo apt install python3-pip python3-venv ffmpeg libmpv1 python3-gi gir1.2-gtk-4.0 gir1.2-adw-1 playerctl

# Fedora
sudo dnf install python3-pip ffmpeg mpv-libs python3-gobject gtk4 libadwaita playerctl

# Arch
sudo pacman -S python-pip ffmpeg mpv python-gobject gtk4 libadwaita playerctl
```

---

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/Arzuparreta/soundsible.git
   cd soundsible
   ```

2. Create and activate virtual environment:
   ```bash
   python3 -m venv venv
   ```
   
   Then activate it:
   
   **Bash/Zsh:**
   ```bash
   source venv/bin/activate
   ```
   
   **Fish shell:**
   ```fish
   source venv/bin/activate.fish
   ```
   
   > **Note for Arch users:** Due to PEP 668, you must use a virtual environment for pip installations. Always activate the venv before installing Python packages.

3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

---

## Using the GUI App (Recommended)

The easiest way to use Soundsible is through the **GTK graphical application**:

```bash
./gui.sh
```

The GUI includes everything you need:
- **Music Player** — Stream and play your library
- **Download & Push (Smart)** — Download music from Spotify/YouTube and upload to cloud *(Menu → Download & Push)*
- **Upload Local Files** — Upload local music files to cloud *(Menu → Upload Local Files)*
- **Setup Wizard** — Configure cloud storage credentials *(Menu → Setup Wizard)*
- **Themes** — Choose between System, Light, Dark, or ODST themes

### First-Time Setup

On first launch, you'll be prompted to run the **Setup Wizard** to configure your cloud storage. This only needs to be done once.

### Optional: Enable Media Keys

For keyboard media control (play/pause/next/previous keys):

Activate your virtual environment first:

**Bash/Zsh:**
```bash
source venv/bin/activate
```

**Fish shell:**
```fish
source venv/bin/activate.fish
```

Then install MPRIS support:
```bash
pip install mpris-server
```

> **Arch users:** You can alternatively install from AUR: `yay -S python-mpris-server`

---

## ODST Tool: Music Downloader

The **ODST Tool** is a dedicated web interface for downloading music from Spotify, YouTube, or YouTube Music links. It downloads music in Soundsible compatible format and can sync directly to your cloud storage.

To use the ODST Tool:

```bash
cd odst_tool
./downloader_web.sh
```

Then open the displayed URL in your browser to access the download interface.

> **Note:** This is different from the GUI's "Download & Push" feature. ODST provides more advanced features including multi-platform link support, playlist selection, smart matching, and batch downloads.

For detailed setup instructions (Spotify API credentials for auto-downloading playlists, etc.), see **[odst_tool/README.md](odst_tool/README.md)**.

### Web Uploader & Cloud Sync

The ODST Tool features a powerful Web UI that can manage your cloud library directly.

> **Tip:** You can use this interface to upload your entire library to Cloudflare R2 / Backblaze B2 without using the command line!

**How to use:**

1.  Click **Settings** in the top right corner.
2.  Under the **Cloud Sync (R2)** section, enter your storage credentials:
    *   Account ID
    *   Access Key ID
    *   Secret Access Key
    *   Bucket Name
    *   *(Note: If you already ran the Setup Wizard in the main app, these might be pre-filled!)*
3.  Click **Save Cloud Config**.
4.  Once configured, click the **Cloud Icon** (next to Settings) to start the sync.
    *   This will automatically upload all downloaded tracks to your bucket.
    *   It also updates the `library.json` database so your other devices stay in sync.

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
| **Cloudflare R2** | 10GB | **FREE** (zero egress) | Yes | Streaming (recommended) |
| **Backblaze B2** | 10GB | $0.01/GB | No | Simple setup, backups |
| **AWS S3** | 5GB (12 months) | $0.09/GB | Yes | AWS ecosystem users |

**Recommendation**: Use Cloudflare R2 for zero bandwidth costs when streaming music.

---

## Project Structure

```
soundsible/
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

**Phase 0: Foundation** (Complete)
- Project structure and virtual environment
- Data models and shared utilities
- S3 storage provider abstraction
- Cloudflare R2 and Backblaze B2 implementations
- Audio metadata extraction and compression

**Phase 1: Setup Tool Core** (Complete)
- CLI interface with guided setup
- Parallel upload engine
- Configuration management

**Phase 2-3: Upload Engine & Web Interface** (Complete)

**Phase 4-6: Music Player** (Complete)

---

## Legal & Disclaimer

> **IMPORTANT: This software is provided for personal, educational, and research purposes only.**

### Copyright & Fair Use

- **No copyrighted content is distributed** — This software does not host, distribute, or provide access to any copyrighted material
- **User responsibility** — Users are solely responsible for ensuring they have the legal right to download, upload, and stream any content they access through this software
- **Personal use** — This tool is intended for personal music library management, similar to how a web browser accesses publicly available content
- **No DRM circumvention** — This software does not bypass, decrypt, or circumvent any Digital Rights Management (DRM) or technical protection measures

### Terms of Service

Using this software to download content may violate the Terms of Service of third-party platforms (YouTube, Spotify, etc.). While ToS violations are generally contractual matters (not criminal), users should review and understand the terms of any service they interact with.

### Security

- **Credential security** — Cloud storage credentials are encrypted locally using industry-standard cryptography
- **Privacy** — No telemetry, analytics, or data collection of any kind

### Liability

THE AUTHORS AND COPYRIGHT HOLDERS SHALL NOT BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY ARISING FROM THE USE OF THIS SOFTWARE. Users assume all risk and responsibility for their usage.

### DMCA Notice

If you are a copyright holder and believe this software facilitates infringement of your rights, please open a GitHub issue with details. We are committed to addressing legitimate concerns.

---

## Acknowledgements & Credits

This project is built upon the incredible work of open-source communities. We gratefully acknowledge:

### Core Dependencies

| Library | License | Description |
|---------|---------|-------------|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Unlicense | YouTube video/audio downloader |
| [spotipy](https://github.com/spotipy-dev/spotipy) | MIT | Spotify Web API client |
| [mutagen](https://github.com/quodlibet/mutagen) | GPL-2.0 | Audio metadata handling |
| [Flask](https://github.com/pallets/flask) | BSD-3-Clause | Web framework |
| [boto3](https://github.com/boto/boto3) | Apache-2.0 | AWS/S3 SDK |
| [PyGObject](https://pygobject.readthedocs.io/) | LGPL-2.1 | GTK Python bindings |
| [python-mpv](https://github.com/jaseg/python-mpv) | AGPL-3.0 | mpv media player bindings |
| [Rich](https://github.com/Textualize/rich) | MIT | Terminal formatting |
| [Pillow](https://github.com/python-pillow/Pillow) | HPND | Image processing |

### Special Thanks

- **[yt-dlp Team](https://github.com/yt-dlp/yt-dlp)** — For maintaining an exceptional download tool
- **[mpv](https://mpv.io/)** — For the powerful media player engine
- **[GTK](https://gtk.org/)** / **[GNOME](https://www.gnome.org/)** — For the Adwaita UI framework
- **[Cloudflare](https://www.cloudflare.com/)** & **[Backblaze](https://www.backblaze.com/)** — For affordable cloud storage

---

## License

MIT License — See [LICENSE](LICENSE) file for full text.

---

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## Support

For issues and questions, please use [GitHub Issues](https://github.com/Arzuparreta/soundsible/issues).
