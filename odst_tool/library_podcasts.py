"""Read ODST's two podcast fields without retaining the disk track collection.

Every track is decoded/validated and immediately discarded. JSON syntax and
LibraryMetadata.from_json's legacy rejection/default rules remain authoritative;
no regex extraction, file cache, offsets or model copy is retained. Peak memory
for valid input is one track/header field plus selected podcast data and buffer.
"""
from dataclasses import MISSING, fields
import json
import re
from typing import TextIO

from shared.models import Track

_REQUIRED = frozenset(field.name for field in fields(Track)
                      if field.default is MISSING and field.default_factory is MISSING)
_SPACE = re.compile(r'[ \t\r\n]*')


class _Reader:
    def __init__(self, source: TextIO, chunk_size: int):
        self.source = source
        self.chunk_size = chunk_size
        self.buffer = ''
        self.position = 0
        self.eof = False
        self.decoder = json.JSONDecoder()

    def more(self):
        if self.eof:
            return False
        self.buffer = self.buffer[self.position:]
        self.position = 0
        piece = self.source.read(self.chunk_size)
        self.buffer += piece
        self.eof = not piece
        return bool(piece)

    def peek(self):
        while True:
            self.position = _SPACE.match(self.buffer, self.position).end()
            if self.position < len(self.buffer):
                return self.buffer[self.position]
            if not self.more():
                return ''

    def error(self):
        raise json.JSONDecodeError('Invalid portable library JSON', self.buffer, self.position)

    def take(self, character):
        if self.peek() != character:
            self.error()
        self.position += 1

    def value(self):
        if not self.peek():
            self.error()
        while True:
            try:
                value, end = self.decoder.raw_decode(self.buffer, self.position)
            except json.JSONDecodeError:
                if self.more():
                    continue
                raise
            # A token can straddle a buffer boundary: "1" may continue as
            # "123" or "1e+3". Require a delimiter or EOF before accepting it.
            if end == len(self.buffer) and not self.eof:
                self.more()
                continue
            if end < len(self.buffer) and self.buffer[end] not in ' \t\r\n,]}:':
                if self.more():
                    continue
                self.error()
            self.position = end
            return value

    def tracks(self):
        if self.peek() != '[':
            value = self.value()
            # from_dict iterates tracks: empty dict/string are historically
            # accepted, whereas nonempty ones and non-iterables fail.
            return isinstance(value, (dict, str)) and not value
        self.take('[')
        valid = True
        if self.peek() == ']':
            self.take(']')
            return valid
        while True:
            track = self.value()
            valid = valid and isinstance(track, dict) and _REQUIRED.issubset(track)
            del track
            if self.peek() == ']':
                self.take(']')
                return valid
            self.take(',')
            # A comma must be followed by another JSON value, not ']'.

    def finish(self):
        if self.peek():
            self.error()


def read_podcast_fields(source: TextIO, *, chunk_size: int = 64 * 1024) -> tuple[list, dict]:
    """Match the old model reader's podcast projection with bounded track work.

    Malformed JSON returns empty podcast fields, as LibraryMetadata.from_json
    does. Valid JSON that could not construct the old model raises TypeError;
    ODST's existing caller then retains its in-memory podcasts. Types/defaults,
    duplicate root keys (last wins) and trailing-data validation are preserved.
    The descriptor is opened/owned by the caller, just as before.
    """
    if chunk_size < 1:
        raise ValueError('chunk_size must be positive')
    reader = _Reader(source, chunk_size)
    subscriptions, cache = [], {}
    valid_tracks = True
    version, legacy_version = None, '1'
    try:
        if reader.peek() != '{':
            reader.value()
            reader.finish()
            raise TypeError('Library root must be an object')
        reader.take('{')
        if reader.peek() != '}':
            while True:
                key = reader.value()
                if not isinstance(key, str):
                    reader.error()
                reader.take(':')
                if key == 'tracks':
                    valid_tracks = reader.tracks()
                else:
                    value = reader.value()
                    if key == 'version':
                        version = value
                    elif key == 'library_version':
                        legacy_version = value
                    elif key == 'podcast_subscriptions':
                        subscriptions = value if isinstance(value, list) else []
                    elif key == 'podcast_episode_cache':
                        cache = value if isinstance(value, dict) else {}
                    del value
                if reader.peek() == '}':
                    break
                reader.take(',')
        reader.take('}')
        reader.finish()
    except json.JSONDecodeError:
        return [], {}
    if not valid_tracks:
        raise TypeError('Invalid track collection')
    # from_dict defaults ordinary version conversion errors, but propagates
    # OverflowError (e.g. Infinity). Keep that rare retain-in-memory behavior.
    try:
        int(legacy_version if version is None else version)
    except (ValueError, TypeError):
        pass
    return subscriptions, cache
