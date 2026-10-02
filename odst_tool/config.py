import os
from pathlib import Path
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

DEFAULT_OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", str(Path.home() / "Music" / "Soundsible")))
DEFAULT_WORKERS = 4

# A bitrate of 0 keeps the stream's own codec and quality.
QUALITY_PROFILES = {
    "standard": {"bitrate": 128, "format": "mp3"},
    "high": {"bitrate": 320, "format": "mp3"},
    "ultra": {"bitrate": 0, "format": "best"},
}
DEFAULT_QUALITY = os.getenv("DEFAULT_QUALITY", "high")

# Which YouTube surface to search first.
#
# This defaulted to YouTube Music for its cleaner metadata, with plain YouTube as
# an escape hatch for stations whose datacenter address YouTube Music will not
# answer. In practice that left a relayed station and a desktop resolving tracks
# differently, and the premise no longer holds either: YouTube Music's search
# returns ids and titles and nothing else — no creator, no duration — so
# "cleaner metadata" cost a full extraction per row to recover, and the duration
# never came back at all.
#
# Plain search carries title, creator and duration together, and the ranking
# YouTube Music would have added is now covered by the source preference in
# `shared.resolution_confidence`, which favours the artist's own upload. Anyone
# who wants YouTube Music back can still ask for it.
_SEARCH_SOURCE_DEFAULT = "youtube"


def prefer_ytmusic() -> bool:
    """Default for ``search_youtube(use_ytmusic=...)``. Read at call time so the
    environment can change without a reimport."""
    raw = (os.getenv("SOUNDSIBLE_YT_SEARCH_SOURCE") or _SEARCH_SOURCE_DEFAULT).strip().lower()
    return raw not in ("youtube", "yt", "plain")


SEARCH_STRATEGY_PRIMARY = "{artist} - {title} official audio"
SEARCH_STRATEGY_FALLBACK = "{artist} - {title}"
DURATION_TOLERANCE_SEC = 20
FORBIDDEN_KEYWORDS = ['cover', 'live', 'remix', 'karaoke', 'instrumental', 'performed by']
DOWNLOAD_DELAY_RANGE = (1, 5)  # Seconds between searched downloads, against throttling

LIBRARY_FILENAME = "library.json"
TRACKS_DIR = "tracks"
