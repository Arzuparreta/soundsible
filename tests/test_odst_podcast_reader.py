import io
import json
import os
import random
from unittest.mock import patch

import pytest

from odst_tool.library_podcasts import read_podcast_fields
from shared.models import LibraryMetadata, Track
from scripts.benchmark_library_export import library


def reference(text):
    try:
        model = LibraryMetadata.from_json(text)
        return model.podcast_subscriptions, model.podcast_episode_cache
    except (TypeError, AttributeError, OverflowError):
        return 'retain'


def result(text, size):
    try:
        return read_podcast_fields(io.StringIO(text), chunk_size=size)
    except (TypeError, AttributeError, OverflowError):
        return 'retain'


@pytest.mark.parametrize('size', [1, 2, 7, 64, 65536])
def test_matches_model_defaults_types_and_malformed_documents(size):
    track = library(1).tracks[0].to_public_dict()
    valid = json.dumps({'tracks': [track], 'podcast_subscriptions': [{'title': 'Español " \\ \n 💿'}],
                        'podcast_episode_cache': {'feed': [1.25e-20, True, None, {'nested': ['x']}]}}, ensure_ascii=False)
    cases = [valid, '{}', '', '{', '[]', 'null', 'true', '1', 'NaN', '"text"',
             '{"tracks":[] ,}', '{"tracks":[,]}', '{"tracks":[1,]}', valid + 'garbage',
             '{"podcast_subscriptions":[1],"podcast_subscriptions":[2]}',
             '{"podcast_episode_cache":{"a":1},"podcast_episode_cache":null}',
             '{"tracks":[{}],"tracks":[]}', '{"tracks":[],"tracks":[{}]}',
             '{"tracks":[{}],bad}', '{"tracks": ""}', '{"tracks":{}}',
             '{"tracks": {"x":1}}', '{"tracks":null}', '{"tracks":1}',
             '{"podcast_subscriptions":{},"podcast_episode_cache":[]}',
             '{"x":1e+300,"podcast_subscriptions":[1]}',
             '{"x":NaN,"podcast_episode_cache":{"number":Infinity}}',
             '{"tracks":[{}],"version":Infinity}',
             '{"version":Infinity,"podcast_subscriptions":[1]}',
             '{"version":null,"library_version":Infinity,"podcast_subscriptions":[1]}']
    for text in cases:
        assert result(text, size) == reference(text), (size, text[:80])


def test_reads_in_chunks_and_never_constructs_tracks():
    model = library(500)
    model.podcast_episode_cache = {'feed': [{'x': 'y'}]}
    text = model.to_json()

    class LimitedReader(io.StringIO):
        def read(self, size=-1):
            assert 0 < size <= 65536
            return super().read(size)

    with patch.object(Track, 'from_dict', side_effect=AssertionError('track construction')):
        assert read_podcast_fields(LimitedReader(text)) == ([], model.podcast_episode_cache)


def test_differential_random_documents_and_truncations():
    rng = random.Random(724)
    base = library(2).to_public_dict()
    for _ in range(100):
        data = dict(base)
        data['podcast_subscriptions'] = rng.choice([None, [], [{'id': rng.randrange(100), 'name': 'é'}], 'bad'])
        data['podcast_episode_cache'] = rng.choice([None, {}, {'nested': [1, {'x': '\\"'}]}, []])
        pairs = list(data.items())
        rng.shuffle(pairs)
        text = json.dumps(dict(pairs), ensure_ascii=rng.choice([True, False]), indent=rng.choice([None, 2]))
        assert result(text, rng.randrange(1, 200)) == reference(text)
        cut = rng.randrange(len(text))
        assert result(text[:cut], 37) == reference(text[:cut])


@pytest.mark.skipif(os.name == 'nt', reason='POSIX replacement of an open file')
def test_atomic_replacement_during_read_keeps_one_descriptor_snapshot(tmp_path):
    old = library(3)
    old.podcast_subscriptions = [{'id': 'old'}]
    new = library(3)
    new.podcast_subscriptions = [{'id': 'new'}]
    source = tmp_path / 'library.json'
    source.write_text(old.to_json())
    replacement = tmp_path / 'replacement.json'
    replacement.write_text(new.to_json())

    class ReplaceDuringRead:
        def __init__(self, handle):
            self.handle = handle
            self.replaced = False

        def read(self, size):
            piece = self.handle.read(size)
            if not self.replaced:
                os.replace(replacement, source)
                self.replaced = True
            return piece

    with source.open() as handle:
        assert read_podcast_fields(ReplaceDuringRead(handle), chunk_size=31)[0] == [{'id': 'old'}]
    with source.open() as handle:
        assert read_podcast_fields(handle)[0] == [{'id': 'new'}]


def test_late_io_failure_propagates():
    class FailedReader:
        def read(self, size):
            raise OSError('read failed')

    with pytest.raises(OSError, match='read failed'):
        read_podcast_fields(FailedReader())
