"""Bounded fingerprints of mutable library models; no retained encoded data."""
from dataclasses import fields
from hashlib import sha256
from pickle import Pickler
from io import BytesIO

from shared.models import LibraryMetadata, Track

TRACK_FIELDS = tuple(f.name for f in fields(Track) if f.name not in {"local_path", "local_mtime_ns"})
HEADER_FIELDS = ("version", "playlists", "settings", "last_updated", "podcast_subscriptions", "podcast_episode_cache")


class _DigestWriter:
    def __init__(self):
        self.digest = sha256()

    def write(self, data):
        self.digest.update(data)


def fingerprint(metadata: LibraryMetadata | dict, *, public_tracks=None, public_headers=None) -> str:
    """Same fingerprint for a model and its detached public representation.

    Unsupported models disable the shortcut at the caller. The materialized
    snapshot supplies the cache key on misses, so mutations during copying
    cannot associate a validator with different content.
    """
    writer = _DigestWriter()
    encoder = Pickler(writer, protocol=5)
    encoder.fast = True  # Values, not Python object-sharing topology.
    if isinstance(metadata, dict):
        if len(metadata) != len(HEADER_FIELDS) + 1:
            raise TypeError("Unsupported public snapshot")
        header = tuple(metadata[name] for name in HEADER_FIELDS)
        tracks = metadata['tracks']

        def public_values():
            for track in tracks:
                if len(track) != len(TRACK_FIELDS):
                    raise TypeError("Unsupported public track")
                yield tuple(track[name] for name in TRACK_FIELDS)

        rows = public_values()
    else:
        if type(metadata) is not LibraryMetadata:
            raise TypeError("Unsupported library model")
        header = tuple(public_headers[name] if public_headers is not None else getattr(metadata, name) for name in HEADER_FIELDS)
        tracks = metadata.tracks

        def values():
            for position, track in enumerate(tracks):
                if public_tracks is not None and position in public_tracks:
                    row = public_tracks[position]
                    if len(row) != len(TRACK_FIELDS):
                        raise TypeError("Unsupported public track")
                    yield tuple(row[name] for name in TRACK_FIELDS)
                    continue
                if type(track) is not Track:
                    raise TypeError("Unsupported track model")
                yield tuple(getattr(track, name) for name in TRACK_FIELDS)

        rows = values()
    encoder.dump((header, len(tracks)))
    encoder.clear_memo()
    for row in rows:
        encoder.dump(row)
        encoder.clear_memo()
    return writer.digest.hexdigest()


def encoded_values(value):
    """The same memo-free encoding as fingerprint(), bounded to one row."""
    buffer = BytesIO()
    encoder = Pickler(buffer, protocol=5)
    encoder.fast = True
    encoder.dump(value)
    return buffer.getvalue()
