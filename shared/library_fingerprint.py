"""Bounded fingerprints of mutable library models; no retained encoded data."""
from dataclasses import fields
from hashlib import sha256
from pickle import Pickler
from io import BytesIO
from operator import attrgetter, itemgetter

from shared.models import PUBLIC_HEADER_FIELDS as HEADER_FIELDS, LibraryMetadata, Track

TRACK_FIELDS = tuple(f.name for f in fields(Track) if f.name not in {"local_path", "local_mtime_ns"})
track_values = attrgetter(*TRACK_FIELDS)
_public_values = itemgetter(*TRACK_FIELDS)


class _DigestWriter:
    def __init__(self):
        self.digest = sha256()
        self.previous = None

    def write(self, data):
        self.digest.update(data)
        if self.previous is not None:
            self.previous.update(data)


def _pickler(writer):
    encoder = Pickler(writer, protocol=5)
    encoder.fast = True  # Values, not Python object-sharing topology.
    return encoder


def fingerprint(metadata: LibraryMetadata | dict) -> str:
    """Same fingerprint for a model and its detached public representation.

    Unsupported models disable the shortcut at the caller. The materialized
    snapshot supplies the cache key on misses, so mutations during copying
    cannot associate a validator with different content.
    """
    writer = _DigestWriter()
    encoder = _pickler(writer)
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
            for track in tracks:
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


def track_edit_fingerprints(headers, tracks, position, before, after):
    """Fingerprint both sides of an edit using the same bytes for shared rows."""
    writer = _DigestWriter()
    encoder = _pickler(writer)
    encoder.dump((tuple(headers[name] for name in HEADER_FIELDS), len(tracks)))
    encoder.clear_memo()
    for index, track in enumerate(tracks):
        if type(track) is not Track:
            raise TypeError("Unsupported track model")
        if index == position:
            writer.previous = writer.digest.copy()
            writer.previous.update(encoded_values(_public_values(before)))
            writer.digest.update(encoded_values(_public_values(after)))
        else:
            encoder.dump(track_values(track))
            encoder.clear_memo()
    if writer.previous is None:
        raise ValueError("Track edit changed library membership")
    return writer.previous.hexdigest(), writer.digest.hexdigest()


def encoded_values(value):
    """The same memo-free encoding as fingerprint(), bounded to one row."""
    buffer = BytesIO()
    encoder = _pickler(buffer)
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


def header_digest(headers: dict) -> str:
    """Hash of a `LibraryMetadata.public_headers()` mapping."""
    return sha256(encoded_values(tuple(headers[name] for name in HEADER_FIELDS))).hexdigest()
