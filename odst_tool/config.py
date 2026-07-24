import os
from pathlib import Path
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# Note: App configuration
APP_NAME = "ODST"
VERSION = "1.0.0"

# Note: Paths details
BASE_DIR = Path(__file__).parent.absolute()
DEFAULT_OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", str(Path.home() / "Music" / "Soundsible")))
CACHE_DIR = Path.home() / ".cache" / "soundsible-odst"
CREDENTIALS_DIR = Path.home() / ".config" / "soundsible"

# Note: Create directories if they don't exist
CACHE_DIR.mkdir(parents=True, exist_ok=True)
CREDENTIALS_DIR.mkdir(parents=True, exist_ok=True)

# Note: Download settings
DEFAULT_FORMAT = "mp3"
DEFAULT_BITRATE = 320
DEFAULT_WORKERS = 4

# Note: Quality profiles
# Note: 0 Bitrate means 'best' / no forced re-encoding
QUALITY_PROFILES = {
    "standard": {"bitrate": 128, "format": "mp3", "label": "Standard (128k)"},
    "high": {"bitrate": 320, "format": "mp3", "label": "High Quality (320k)"},
    "ultra": {"bitrate": 0, "format": "best", "label": "Ultra (Best Source Audio)"}
}
DEFAULT_QUALITY = os.getenv("DEFAULT_QUALITY", "high")

# Note: Search settings
# Which YouTube surface to search first. YouTube Music gives cleaner metadata,
# but it is not always reachable from a datacenter IP — a VPS may have to fall
# back to plain YouTube. Set SOUNDSIBLE_YT_SEARCH_SOURCE=youtube there instead
# of patching call sites.
YT_SEARCH_SOURCE = (os.getenv("SOUNDSIBLE_YT_SEARCH_SOURCE") or "ytmusic").strip().lower()


def prefer_ytmusic() -> bool:
    """Default for ``search_youtube(use_ytmusic=...)``. Read at call time so the
    environment can change without a reimport."""
    raw = (os.getenv("SOUNDSIBLE_YT_SEARCH_SOURCE") or "ytmusic").strip().lower()
    return raw not in ("youtube", "yt", "plain")


SEARCH_STRATEGY_PRIMARY = "{artist} - {title} official audio"
SEARCH_STRATEGY_FALLBACK = "{artist} - {title}"
DURATION_TOLERANCE_SEC = 20
MATCH_THRESHOLD_TITLE = 0.5
FORBIDDEN_KEYWORDS = ['cover', 'live', 'remix', 'karaoke', 'instrumental', 'performed by']
DEFAULT_COOKIE_BROWSER = "firefox"
DOWNLOAD_DELAY_RANGE = (1, 5) # Note: Seconds to wait between downloads to avoid throttling

# Note: Storage settings
# Note: Compatible with soundsible
LIBRARY_FILENAME = "library.json"
TRACKS_DIR = "tracks"
