from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Protocol

from shared.models import Track


@dataclass(frozen=True)
class LosslessCandidate:
    provider: str
    source_id: str
    title: str
    artist: str
    album: str
    duration: int
    download_url: str
    webpage_url: str
    license_url: str
    format: str
    expected_size: int | None = None
    original: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "LosslessCandidate":
        allowed = cls.__dataclass_fields__
        return cls(**{key: value[key] for key in allowed if key in value})


class LosslessProvider(Protocol):
    name: str

    @property
    def available(self) -> bool: ...

    def search(self, track: Track, *, limit: int = 3) -> list[LosslessCandidate]: ...
