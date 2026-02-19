"""
Canonical metadata domain objects for downloader ingestion.
"""

from dataclasses import dataclass, asdict, field
from typing import Any, Dict, Optional
import uuid


@dataclass
class MetadataEvidence:
    title: Optional[str] = None
    artist: Optional[str] = None
    album: Optional[str] = None
    duration_sec: Optional[int] = None
    video_id: Optional[str] = None
    channel: Optional[str] = None
    source: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Optional[Dict[str, Any]]) -> "MetadataEvidence":
        if not isinstance(data, dict):
            return cls()
        return cls(
            title=data.get("title"),
            artist=data.get("artist"),
            album=data.get("album"),
            duration_sec=data.get("duration_sec"),
            video_id=data.get("video_id"),
            channel=data.get("channel"),
            source=data.get("source"),
        )


@dataclass
class CanonicalMetadata:
    title: str
    artist: str
    album: str
    album_artist: Optional[str] = None
    year: Optional[int] = None
    track_number: Optional[int] = None
    album_art_url: Optional[str] = None
    musicbrainz_id: Optional[str] = None
    isrc: Optional[str] = None
    duration_sec: int = 0
    metadata_source_authority: str = "manual"
    metadata_confidence: float = 0.0
    metadata_state: str = "fallback_youtube"
    metadata_query_fingerprint: Optional[str] = None
    metadata_decision_id: str = field(default_factory=lambda: uuid.uuid4().hex)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class MetadataDecision:
    canonical: CanonicalMetadata
    reason: str
    source_chain: str
    review_candidates: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        out = self.canonical.to_dict()
        out["metadata_reason"] = self.reason
        out["metadata_source_chain"] = self.source_chain
        out["review_candidates"] = self.review_candidates or {}
        return out
