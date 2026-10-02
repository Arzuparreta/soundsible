"""
Shared constants used across the platform.
"""

from shared.runtime import get_cache_dir, get_config_dir


class SourceType:
    """Where a queued download comes from."""

    YOUTUBE_URL = "youtube_url"
    YOUTUBE_SEARCH = "youtube_search"
    YTMUSIC_SEARCH = "ytmusic_search"
    PODCAST_ENCLOSURE = "podcast_enclosure"


LIBRARY_METADATA_FILENAME = "library.json"

SUPPORTED_AUDIO_FORMATS = [
    ".mp3", ".flac", ".ogg", ".m4a", ".wav",
    ".opus", ".aac", ".wma", ".alac"
]

DEFAULT_CACHE_SIZE_GB = 50

CLOUDFLARE_R2_ENDPOINT_TEMPLATE = "https://{account_id}.r2.cloudflarestorage.com"
BACKBLAZE_B2_ENDPOINT_TEMPLATE = "https://s3.{region}.backblazeb2.com"
AWS_S3_ENDPOINT_TEMPLATE = "https://s3.{region}.amazonaws.com"

DEFAULT_CONFIG_DIR = str(get_config_dir())
DEFAULT_CACHE_DIR = str(get_cache_dir())
# Where music goes when no output folder is configured.
DEFAULT_OUTPUT_DIR_FALLBACK = "~/Music/Soundsible"

# The station engine's API port: the one value backend and launcher share.
STATION_PORT = 5005
