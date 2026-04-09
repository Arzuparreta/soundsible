"""
Shared constants used across the platform.
"""

# Note: Source types for downloader
class SourceType:
    YOUTUBE_URL = "youtube_url"
    YOUTUBE_SEARCH = "youtube_search"  # Note: Canonical: youtube
    YTMUSIC_SEARCH = "ytmusic_search"    # Note: Canonical: music (youtube music)

# Note: Library metadata
LIBRARY_VERSION = "1.0"
LIBRARY_METADATA_FILENAME = "library.json"

# Note: Audio formats
SUPPORTED_AUDIO_FORMATS = [
    ".mp3", ".flac", ".ogg", ".m4a", ".wav", 
    ".opus", ".aac", ".wma", ".alac"
]

COMPRESSED_FORMATS = [".mp3", ".ogg", ".opus", ".aac"]
LOSSLESS_FORMATS = [".flac", ".wav", ".alac"]

# Note: Compression settings
DEFAULT_MP3_BITRATE = 320  # Note: Kbps
DEFAULT_OGG_QUALITY = 8    # Note: VBR quality (0-10)

# Note: Upload settings
DEFAULT_PARALLEL_UPLOADS = 4
MAX_PARALLEL_UPLOADS = 8
UPLOAD_CHUNK_SIZE = 10 * 1024 * 1024  # Note: 10MB

# Note: Cache settings
DEFAULT_CACHE_SIZE_GB = 50
MIN_CACHE_SIZE_GB = 1
MAX_CACHE_SIZE_GB = 500

# Note: Sync settings
DEFAULT_SYNC_INTERVAL_MINUTES = 18
MIN_SYNC_INTERVAL_MINUTES = 5

# Note: S3 provider endpoints
CLOUDFLARE_R2_ENDPOINT_TEMPLATE = "https://{account_id}.r2.cloudflarestorage.com"
BACKBLAZE_B2_ENDPOINT_TEMPLATE = "https://s3.{region}.backblazeb2.com"
AWS_S3_ENDPOINT_TEMPLATE = "https://s3.{region}.amazonaws.com"

# Note: Configuration paths
DEFAULT_CONFIG_DIR = "~/.config/soundsible"
DEFAULT_CACHE_DIR = "~/.cache/soundsible"
# Note: Fallback when output_dir is not set (shared code avoids depending on odst_tool)
DEFAULT_OUTPUT_DIR_FALLBACK = "~/Music/Soundsible"
DEFAULT_DATA_DIR = "~/.local/share/soundsible"
DEFAULT_LIBRARY_PATH = DEFAULT_CONFIG_DIR + "/" + LIBRARY_METADATA_FILENAME

# Note: Network settings
STATION_PORT = 5005  # Note: Station engine API port (single source of truth for backend + launcher)
DEFAULT_NETWORK_TIMEOUT = 30  # Note: Seconds
DEFAULT_DOWNLOAD_CHUNK_SIZE = 8192  # Note: Bytes

# Note: UI constants
DEFAULT_COVER_ART_SIZE = 48  # Note: Pixels
DEFAULT_SIDEBAR_WIDTH = 300  # Note: Pixels
DEFAULT_PROGRESS_BAR_MIN_WIDTH = 200  # Note: Pixels
DEFAULT_TITLE_MIN_WIDTH = 50  # Note: Pixels
DEFAULT_TITLE_MAX_WIDTH = 250  # Note: Pixels
