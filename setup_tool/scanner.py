"""Deterministic, structured scanner for existing music folders.

The scanner only reads files. Merging and persistence are deliberately owned by
the API scan service so a long scan can never overwrite a newer library snapshot.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Optional

from setup_tool.audio import AudioProcessor
from shared.models import Track
from shared.path_resolver import path_within_roots


@dataclass
class ScannedFile:
    path: str
    track: Track
    unchanged: bool = False


@dataclass
class ScanResult:
    discovered: int = 0
    processed: int = 0
    files: list[ScannedFile] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


ProgressCallback = Callable[[ScanResult], None]


class LibraryScanner:
    """Read metadata and content hashes from approved local roots."""

    def discover(self, roots: Iterable[str | Path]) -> list[Path]:
        approved = [Path(root).expanduser().resolve(strict=True) for root in roots]
        found: list[Path] = []
        seen: set[str] = set()
        for root in approved:
            if not root.is_dir():
                continue
            for candidate in root.rglob("*"):
                # Never follow a symlinked file or directory into another tree.
                if candidate.is_symlink() or not candidate.is_file():
                    continue
                if not path_within_roots(candidate, approved):
                    continue
                if not AudioProcessor.is_supported_format(str(candidate)):
                    continue
                key = str(candidate.resolve())
                if key not in seen:
                    seen.add(key)
                    found.append(candidate.resolve())
        return sorted(found, key=lambda path: str(path).casefold())

    def scan_paths(
        self,
        roots: Iterable[str | Path],
        existing_tracks: Iterable[Track],
        *,
        progress: Optional[ProgressCallback] = None,
    ) -> ScanResult:
        roots = list(roots)
        result = ScanResult()
        files = self.discover(roots)
        result.discovered = len(files)
        if progress:
            progress(result)

        by_path: dict[str, Track] = {}
        for track in existing_tracks:
            if track.local_path:
                try:
                    by_path[str(Path(track.local_path).expanduser().resolve())] = track
                except (OSError, RuntimeError):
                    continue

        for file_path in files:
            try:
                stat = file_path.stat()
                existing = by_path.get(str(file_path))
                if (
                    existing is not None
                    and existing.file_size == stat.st_size
                    and existing.local_mtime_ns == stat.st_mtime_ns
                ):
                    result.files.append(ScannedFile(str(file_path), existing, unchanged=True))
                else:
                    result.files.append(
                        ScannedFile(
                            str(file_path),
                            self._process_file(file_path, stat.st_size, stat.st_mtime_ns),
                        )
                    )
            except Exception as exc:
                # Do not leak absolute server paths through the public status.
                result.errors.append(f"{file_path.name}: {type(exc).__name__}")
            result.processed += 1
            if progress:
                progress(result)
        return result

    @staticmethod
    def _process_file(file_path: Path, size: int, mtime_ns: int) -> Track:
        file_hash = AudioProcessor.calculate_hash(str(file_path))
        meta = AudioProcessor.extract_metadata(str(file_path))
        return Track(
            id=file_hash,
            title=meta.get("title", "Unknown"),
            artist=meta.get("artist", "Unknown"),
            album=meta.get("album", "Unknown"),
            album_artist=meta.get("album_artist"),
            duration=meta.get("duration", 0),
            file_hash=file_hash,
            original_filename=file_path.name,
            compressed=False,
            file_size=size,
            bitrate=meta.get("bitrate", 0),
            format=meta.get("format", file_path.suffix.lstrip(".").lower() or "mp3"),
            year=meta.get("year"),
            genre=meta.get("genre"),
            track_number=meta.get("track_number"),
            artists=meta.get("artists"),
            disc_number=meta.get("disc_number"),
            disc_total=meta.get("disc_total"),
            is_compilation=bool(meta.get("is_compilation")),
            is_local=True,
            local_path=str(file_path),
            local_mtime_ns=mtime_ns,
        )
