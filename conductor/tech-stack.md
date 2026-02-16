# Soundsible Technology Stack

## Core & Backend
- **Language:** Python 3.10+
- **API Framework:** Flask
- **Real-time Communication:** Flask-SocketIO (WebSockets)
- **API Security:** Flask-CORS
- **Audio Processing:** FFMPEG (via `ffmpeg-python`), Mutagen (Metadata)
- **Database:** SQLite (Local indexing)
- **Cloud Storage SDKs:** `boto3` (S3/R2), `b2sdk` (Backblaze B2)

## Frontend (WebUI / PWA)
- **Language:** Vanilla JavaScript (ES6+)
- **Styling:** CSS3, Tailwind CSS (via CDN)
- **Icons:** Font Awesome
- **Architecture:** Progressive Web App (PWA) with Service Workers

## Desktop Frontend (Linux)
- **Bindings:** PyGObject (GTK4 / Libadwaita)
- **Media Engine:** `python-mpv` (mpv integration)
- **System Integration:** `mpris-server` (D-Bus), `pystray` (System Tray)

## Tools & Development
- **Downloader Core:** `yt-dlp` (via ODST Tool)
- **Environment:** `python-dotenv`
- **Testing:** `pytest`, `pytest-asyncio`
- **Formatting:** `black`, `mypy`
