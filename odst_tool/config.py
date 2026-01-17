import os
from pathlib import Path
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# App Configuration
APP_NAME = "SpotifyYouTubeDL"
VERSION = "1.0.0"

# Paths
BASE_DIR = Path(__file__).parent.absolute()
DEFAULT_OUTPUT_DIR = Path.home() / "Music" / "Spotify"
CACHE_DIR = Path.home() / ".cache" / "spotify-youtube-dl"
CREDENTIALS_DIR = Path.home() / ".config" / "spotify-youtube-dl"

# Create directories if they don't exist
CACHE_DIR.mkdir(parents=True, exist_ok=True)
CREDENTIALS_DIR.mkdir(parents=True, exist_ok=True)

# Spotify Settings
SPOTIFY_CLIENT_ID = os.getenv("SPOTIFY_CLIENT_ID")
SPOTIFY_CLIENT_SECRET = os.getenv("SPOTIFY_CLIENT_SECRET")

# Fallback to sh-music-hub env if not found
if not SPOTIFY_CLIENT_ID or not SPOTIFY_CLIENT_SECRET:
    try:
        # Check sibling directory
        sibling_env = BASE_DIR.parent / "sh-music-hub" / ".env"
        if sibling_env.exists():
            from dotenv import dotenv_values
            env_vars = dotenv_values(sibling_env)
            if not SPOTIFY_CLIENT_ID:
                SPOTIFY_CLIENT_ID = env_vars.get("SPOTIFY_CLIENT_ID")
            if not SPOTIFY_CLIENT_SECRET:
                SPOTIFY_CLIENT_SECRET = env_vars.get("SPOTIFY_CLIENT_SECRET")
    except Exception:
        pass

SPOTIFY_REDIRECT_URI = "http://localhost:8888/callback"
SPOTIFY_SCOPE = "user-library-read playlist-read-private playlist-read-collaborative user-read-private"

# Download Settings
DEFAULT_FORMAT = "mp3"
DEFAULT_BITRATE = 192
DEFAULT_WORKERS = 4

# Search Settings
SEARCH_STRATEGY_PRIMARY = "{artist} - {title} official audio"
SEARCH_STRATEGY_FALLBACK = "{artist} - {title}"
DURATION_TOLERANCE_SEC = 20
MATCH_THRESHOLD_TITLE = 0.6
FORBIDDEN_KEYWORDS = ['cover', 'live', 'remix', 'karaoke', 'instrumental', 'performed by']
DEFAULT_COOKIE_BROWSER = "firefox"
DOWNLOAD_DELAY_RANGE = (1, 5) # Seconds to wait between downloads to avoid throttling

# Storage Settings
# Compatible with sh-music-hub
LIBRARY_FILENAME = "library.json"
TRACKS_DIR = "tracks"
