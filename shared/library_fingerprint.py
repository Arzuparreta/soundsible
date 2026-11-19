"""Bounded fingerprints of mutable library models; no retained encoded data."""
from copy import deepcopy
from dataclasses import fields
from hashlib import sha256
from pickle import Pickler
from io import BytesIO
from operator import attrgetter, itemgetter

from shared.models import LibraryMetadata, Track

TRACK_FIELDS = tuple(f.name for f in fields(Track) if f.name not in {"local_path", "local_mtime_ns"})
HEADER_FIELDS = ("version", "playlists", "settings", "last_updated", "podcast_subscriptions", "podcast_episode_cache")
track_values = attrgetter(*TRACK_FIELDS)
_public_values = itemgetter(*TRACK_FIELDS)


class _DigestWriter:
    def __init__(self):
        self.digest = sha256()

    def write(self, data):
        self.digest.update(data)


def fingerprint(metadata: LibraryMetadata | dict, *, public_tracks=None) -> str:
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
                yield _public_values(track)

        rows = public_values()
    else:
        if type(metadata) is not LibraryMetadata:
            raise TypeError("Unsupported library model")
        header = tuple(getattr(metadata, name) for name in HEADER_FIELDS)
        tracks = metadata.tracks

        def values():
            for position, track in enumerate(tracks):
                if public_tracks is not None and position in public_tracks:
                    row = public_tracks[position]
                    if len(row) != len(TRACK_FIELDS):
                        raise TypeError("Unsupported public track")
                    yield _public_values(row)
                    continue
                if type(track) is not Track:
                    raise TypeError("Unsupported track model")
                yield track_values(track)

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


def row_digest(values) -> bytes:
    """The committed per-track hash (`library_public_rows.hash`) of one row's values."""
    return sha256(encoded_values(values)).digest()


def public_row_digest(row: dict) -> bytes:
    """`row_digest` of a detached `Track.to_public_dict()` row."""
    if len(row) != len(TRACK_FIELDS):
        raise TypeError("Unsupported public track")
    return row_digest(_public_values(row))


def public_headers(metadata: LibraryMetadata) -> dict:
    """A detached copy of the public header fields, in `HEADER_FIELDS` order."""
    return {name: deepcopy(getattr(metadata, name)) for name in HEADER_FIELDS}


def header_digest(headers: dict) -> str:
    """Hash of a `public_headers()` mapping."""
    return sha256(encoded_values(tuple(headers[name] for name in HEADER_FIELDS))).hexdigest()


def record(metadata: LibraryMetadata, value: str) -> None:
    """Note that `metadata`'s public content had fingerprint `value` just now.

    A hint, never a proof: later in-place edits are not observed. Readers use
    it only to skip a pass whose answer they already know, never to trust
    content or to label a response.
    """
    metadata._public_fingerprint = value


def recorded(metadata) -> str | None:
    return getattr(metadata, "_public_fingerprint", None)
