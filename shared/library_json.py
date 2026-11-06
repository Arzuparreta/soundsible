"""Portable JSON publication metadata, without retaining another library copy."""
from hashlib import sha256
from functools import lru_cache
import json
from json.encoder import encode_basestring_ascii
import os
import sys

_FLAT_JSON = sys.version_info < (3, 13)


@lru_cache(maxsize=128)
def _field_prefix(key):
    # Schema names only, bounded even for models with extension fields.
    return '      ' + encode_basestring_ascii(key) + ': '


def encode_track_block(tracks, *, flat=None):
    """Identical pretty JSON; older Python lacks the C indented-list encoder.

    Fixed string keys and mostly scalar values allow the older interpreters
    to use the standard C string encoder directly. General values still use
    json.dumps, including its validation and nonfinite-number conventions.
    """
    if not (_FLAT_JSON if flat is None else flat):
        return json.dumps(tracks, indent=2)[1:-2].replace('\n', '\n  ')
    rows = []
    for track in tracks:
        if not all(isinstance(key, str) for key in track):
            return json.dumps(tracks, indent=2)[1:-2].replace('\n', '\n  ')
        parts = []
        for key, value in track.items():
            if type(value) is str:
                encoded = encode_basestring_ascii(value)
            elif value is None:
                encoded = 'null'
            elif value is True:
                encoded = 'true'
            elif value is False:
                encoded = 'false'
            elif type(value) is int:
                encoded = str(value)
            elif type(value) is list and all(type(item) is str for item in value):
                encoded = ('[\n        ' + ',\n        '.join(map(encode_basestring_ascii, value))
                           + '\n      ]') if value else '[]'
            else:
                encoded = json.dumps(value, indent=2).replace('\n', '\n      ')
            parts.append(_field_prefix(key) + encoded)
        rows.append('\n    {\n' + ',\n'.join(parts) + '\n    }' if parts else '\n    {}')
    return ','.join(rows)


class LibraryJSONWriter:
    """An atomic-file fill that hashes the bytes written and locates podcasts.

    The offset is usable only against this exact digest. It points at the
    comma preceding the final two root fields, never inside a track. Keep it
    only after publication succeeds; foreign writers use the full reader.
    """

    def __init__(self, metadata):
        self.metadata = metadata
        self.digest = sha256()
        self.podcast_offset = None
        self.size = 0

    def __call__(self, handle):
        from shared.models import LibraryMetadata, Track
        trusted = type(self.metadata) is LibraryMetadata and all(type(track) is Track for track in self.metadata.tracks)
        try:
            int(self.metadata.version)
        except (ValueError, TypeError):
            pass  # These conversion errors default in the full reader.
        except OverflowError:
            trusted = False

        def section(key):
            if trusted and key == 'podcast_subscriptions':
                self.podcast_offset = self.size

        for piece in self.metadata.iter_json(on_section=section):
            data = piece.replace('\n', os.linesep).encode('utf-8')
            handle.write(data)
            self.digest.update(data)
            self.size += len(data)
