"""Streaming signatures match Flask bytes, not merely equivalent JSON values."""
from hashlib import sha256

from flask import Flask
from flask.json.provider import DefaultJSONProvider
import pytest

from shared.api.library_serialization import compact_signature, TRACK_BATCH_SIZE


@pytest.mark.parametrize('count', [0, 1, 499, 500, 501, 1001])
@pytest.mark.parametrize('sort_keys', [False, True])
@pytest.mark.parametrize('ensure_ascii', [False, True])
def test_signature_matches_exact_flask_bytes(count, sort_keys, ensure_ascii):
    app = Flask(__name__)
    app.json.sort_keys = sort_keys
    app.json.ensure_ascii = ensure_ascii
    # Deliberately unsorted keys, Unicode, escapes and nested collections.
    payload = {'version': 1, 'tracks': [
        {'title': 'Canción 🎵 "quoted"\n\\', 'id': str(i), 'artists': ['Á', 'B'],
         'duration': 0.25, 'extra': {'null': None, 'bool': False}}
        for i in range(count)
    ], 'settings': {'z': [-0.0, True], 'a': {'key': '\t'}},
        'playlists': {'Ñ': ['0', '0', 'external']}, 'empty': {}}
    with app.app_context():
        body = app.json.response(payload).get_data()
        assert compact_signature(payload, 'cuenta-ñ') == (
            sha256('cuenta-ñ'.encode() + b'\0' + body).hexdigest(), len(body))
        assert compact_signature(payload, 'other')[0] != compact_signature(payload, 'cuenta-ñ')[0]


def test_batch_size_limits_serialization_calls(monkeypatch):
    app = Flask(__name__)
    original = app.json.dumps
    sizes = []

    def dumps(value, **kwargs):
        if isinstance(value, list):
            sizes.append(len(value))
        return original(value, **kwargs)

    monkeypatch.setattr(app.json, 'dumps', dumps)
    with app.app_context():
        compact_signature({'tracks': [{'id': str(i)} for i in range(1251)]}, 'account')
    assert sizes == [TRACK_BATCH_SIZE, TRACK_BATCH_SIZE, 251]


@pytest.mark.parametrize('compact,debug,supported', [
    (None, False, True), (None, True, False), (False, False, False),
    (False, True, False), (True, True, True),
])
def test_pretty_output_uses_normal_response(compact, debug, supported):
    app = Flask(__name__)
    app.debug = debug
    app.json.compact = compact
    with app.app_context():
        signature = compact_signature({'tracks': []}, 'account')
        assert (signature is not None) == supported
        if supported:
            body = app.json.response({'tracks': []}).get_data()
            assert signature == (sha256(b'account\0' + body).hexdigest(), len(body))


def test_custom_provider_uses_normal_response():
    class Custom(DefaultJSONProvider):
        def dumps(self, obj, **kwargs):
            return super().dumps(obj, **kwargs) + ' '

    app = Flask(__name__)
    app.json = Custom(app)
    with app.app_context():
        assert compact_signature({'tracks': []}, 'account') is None
