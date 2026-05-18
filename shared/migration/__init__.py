"""
Phase 1 migration helpers: parse common export formats and match against the local library.

Auto-accept threshold for high-confidence rows is 0.95 (Phase 1 engineering contract).
"""

from shared.migration.match import (
    AUTO_ACCEPT_THRESHOLD,
    CONFIRM_THRESHOLD,
    MatchResult,
    match_sources_to_library,
    migration_stats,
)
from shared.migration.models import SourceTrack
from shared.migration.parsers import ParseError, parse_export

__all__ = [
    "AUTO_ACCEPT_THRESHOLD",
    "CONFIRM_THRESHOLD",
    "MatchResult",
    "ParseError",
    "SourceTrack",
    "match_sources_to_library",
    "migration_stats",
    "parse_export",
]
