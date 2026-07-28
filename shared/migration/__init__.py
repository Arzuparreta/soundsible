"""
Phase 1 migration helpers: parse common export formats and match against the local library.

Auto-accept threshold for high-confidence rows is 0.95 (Phase 1 engineering contract).
"""

from shared.migration.match import (
    AUTO_ACCEPT_THRESHOLD,
    CONFIRM_THRESHOLD,
    LibraryMatcher,
    MatchResult,
    match_sources_to_library,
    migration_stats,
)
from shared.migration.models import MigrationManifest, SourcePlaylist, SourceTrack
from shared.migration.parsers import (
    ParseError,
    parse_apple_music_csv,
    parse_apple_music_xml,
    parse_export,
    parse_spotify_json,
    parse_spotify_manifest,
    parse_upload,
)

__all__ = [
    "AUTO_ACCEPT_THRESHOLD",
    "CONFIRM_THRESHOLD",
    "LibraryMatcher",
    "MatchResult",
    "MigrationManifest",
    "ParseError",
    "SourceTrack",
    "SourcePlaylist",
    "match_sources_to_library",
    "migration_stats",
    "parse_export",
    "parse_spotify_json",
    "parse_spotify_manifest",
    "parse_apple_music_csv",
    "parse_apple_music_xml",
    "parse_upload",
]
