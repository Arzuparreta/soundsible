"""Small validator cache; never retains a library snapshot or serialized body.

The manifest remains mutable between saves. A streaming fingerprint therefore
checks its public fields on every request instead of trusting only its DB
revision. Pickle is used solely as an internal typed byte encoder; no bytes are
retained or unpickled. Clearing its memo for each track bounds scratch memory
independently of the track count, and ignores cross-track object sharing.
"""
from __future__ import annotations

from dataclasses import fields
from hashlib import sha256
from pickle import Pickler

from shared.api.memo import Memo
from shared.models import LibraryMetadata, Track

_TRACK_FIELDS = tuple(f.name for f in fields(Track) if f.name not in {"local_path", "local_mtime_ns"})
_HEADER_FIELDS = ("version", "playlists", "settings", "last_updated", "podcast_subscriptions", "podcast_episode_cache")
validators: Memo[str] = Memo(ttl_sec=600, maxsize=128)


class _DigestWriter:
    def __init__(self):
        self.digest = sha256()

    def write(self, data):
        self.digest.update(data)


def fingerprint(metadata: LibraryMetadata | dict) -> str:
    """Same fingerprint for a model and its detached public representation.

    Unsupported models disable the shortcut at the caller. The materialized
    snapshot supplies the cache key on misses, so mutations during copying
    cannot associate a validator with different content.
    """
    writer = _DigestWriter()
    encoder = Pickler(writer, protocol=5)
    if isinstance(metadata, dict):
        if len(metadata) != len(_HEADER_FIELDS) + 1:
            raise TypeError("Unsupported public snapshot")
        header = tuple(metadata[name] for name in _HEADER_FIELDS)
        tracks = metadata['tracks']

        def public_values():
            for track in tracks:
                if len(track) != len(_TRACK_FIELDS):
                    raise TypeError("Unsupported public track")
                yield tuple(track[name] for name in _TRACK_FIELDS)

        rows = public_values()
    else:
        if type(metadata) is not LibraryMetadata:
            raise TypeError("Unsupported library model")
        header = tuple(getattr(metadata, name) for name in _HEADER_FIELDS)
        tracks = metadata.tracks

        def values():
            for track in tracks:
                if type(track) is not Track:
                    raise TypeError("Unsupported track model")
                yield tuple(getattr(track, name) for name in _TRACK_FIELDS)

        rows = values()
    encoder.dump((header, len(tracks)))
    encoder.clear_memo()
    for row in rows:
        encoder.dump(row)
        encoder.clear_memo()
    return writer.digest.hexdigest()
