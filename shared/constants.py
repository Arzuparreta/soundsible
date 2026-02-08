"""
Shared constants used across the platform.
"""

# Library metadata
LIBRARY_VERSION = "1.0"
LIBRARY_METADATA_FILENAME = "library.json"

# Audio formats
SUPPORTED_AUDIO_FORMATS = [
    ".mp3", ".flac", ".ogg", ".m4a", ".wav", 
    ".opus", ".aac", ".wma", ".alac"
]

COMPRESSED_FORMATS = [".mp3", ".ogg", ".opus", ".aac"]
LOSSLESS_FORMATS = [".flac", ".wav", ".alac"]

# Compression settings
DEFAULT_MP3_BITRATE = 320  # kbps
DEFAULT_OGG_QUALITY = 8    # VBR quality (0-10)

# Upload settings
DEFAULT_PARALLEL_UPLOADS = 4
MAX_PARALLEL_UPLOADS = 8
UPLOAD_CHUNK_SIZE = 10 * 1024 * 1024  # 10MB

# Cache settings
DEFAULT_CACHE_SIZE_GB = 50
MIN_CACHE_SIZE_GB = 1
MAX_CACHE_SIZE_GB = 500

# Sync settings
DEFAULT_SYNC_INTERVAL_MINUTES = 18
MIN_SYNC_INTERVAL_MINUTES = 5

# S3 Provider endpoints
CLOUDFLARE_R2_ENDPOINT_TEMPLATE = "https://{account_id}.r2.cloudflarestorage.com"
BACKBLAZE_B2_ENDPOINT_TEMPLATE = "https://s3.{region}.backblazeb2.com"
AWS_S3_ENDPOINT_TEMPLATE = "https://s3.{region}.amazonaws.com"

# Configuration paths
DEFAULT_CONFIG_DIR = "~/.config/sh-music-hub"
DEFAULT_CACHE_DIR = "~/.cache/sh-music-hub"
DEFAULT_DATA_DIR = "~/.local/share/sh-music-hub"
DEFAULT_LIBRARY_PATH = DEFAULT_CONFIG_DIR + "/" + LIBRARY_METADATA_FILENAME

# Network Settings
DEFAULT_NETWORK_TIMEOUT = 30  # seconds
DEFAULT_DOWNLOAD_CHUNK_SIZE = 8192  # bytes

# UI Constants
DEFAULT_COVER_ART_SIZE = 48  # pixels
DEFAULT_SIDEBAR_WIDTH = 300  # pixels
DEFAULT_PROGRESS_BAR_MIN_WIDTH = 200  # pixels
DEFAULT_TITLE_MIN_WIDTH = 50  # pixels
DEFAULT_TITLE_MAX_WIDTH = 250  # pixels
