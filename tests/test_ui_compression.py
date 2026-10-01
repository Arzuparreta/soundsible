import gzip

import pytest
from flask import Flask

from shared.ui_assets import serve_ui_asset


@pytest.fixture
def assets(tmp_path):
    original = b"const message = 'Soundsible';\n" * 100
    (tmp_path / "entry.js").write_bytes(original)
    (tmp_path / "entry.js.gz").write_bytes(gzip.compress(original))
    # Negotiation can be tested without a Brotli runtime dependency in Python.
    (tmp_path / "entry.js.br").write_bytes(b"precompressed-brotli-fixture")
    app = Flask(__name__)

    @app.route('/<path:filename>')
    def asset(filename):
        return serve_ui_asset(str(tmp_path), filename)

    return app.test_client(), original, tmp_path


@pytest.mark.parametrize('accept,encoding', [
    ('gzip, br', 'br'), ('gzip;q=1, br;q=0.5', 'gzip'),
    ('br;q=0, gzip', 'gzip'), ('*', 'br'),
    ('identity;q=1, br;q=0.5', None), ('gzip;q=0, br;q=0', None),
    ('', None),
])
def test_negotiation_and_content_type(assets, accept, encoding):
    client, original, _ = assets
    response = client.get('/entry.js', headers={'Accept-Encoding': accept})
    assert response.status_code == 200
    assert response.headers.get('Content-Encoding') == encoding
    assert 'Accept-Encoding' in response.vary
    assert response.mimetype in {'text/javascript', 'application/javascript'}
    if encoding == 'gzip':
        assert gzip.decompress(response.data) == original
    elif encoding is None:
        assert response.data == original


def test_revalidation_is_specific_to_selected_representation(assets):
    client, _, _ = assets
    gzip_response = client.get('/entry.js', headers={'Accept-Encoding': 'gzip'})
    etag = gzip_response.headers['ETag']
    cached = client.get('/entry.js', headers={'Accept-Encoding': 'gzip', 'If-None-Match': etag})
    assert cached.status_code == 304
    assert cached.data == b''
    assert 'Accept-Encoding' in cached.vary
    other = client.get('/entry.js', headers={'Accept-Encoding': 'br', 'If-None-Match': etag})
    assert other.status_code == 200
    assert other.headers['ETag'] != etag


def test_range_and_head_preserve_original_contract(assets):
    client, original, _ = assets
    partial = client.get('/entry.js', headers={'Accept-Encoding': 'br', 'Range': 'bytes=0-9'})
    assert partial.status_code == 206
    assert 'Content-Encoding' not in partial.headers
    assert partial.data == original[:10]
    head = client.head('/entry.js', headers={'Accept-Encoding': 'gzip'})
    assert head.data == b''
    assert head.headers['Content-Encoding'] == 'gzip'
    assert int(head.headers['Content-Length']) < len(original)


def test_missing_variants_fall_back_and_unacceptable_identity_is_rejected(assets):
    client, _, root = assets
    (root / 'old.js').write_bytes(b'old bundle')
    response = client.get('/old.js', headers={'Accept-Encoding': 'br'})
    assert response.data == b'old bundle'
    assert 'Content-Encoding' not in response.headers
    assert client.get('/old.js', headers={'Accept-Encoding': 'br, identity;q=0'}).status_code == 406
    assert client.get('/missing.js').status_code == 404


def test_binary_assets_do_not_negotiate_text_compression(assets):
    client, _, root = assets
    (root / 'cover.png').write_bytes(b'png')
    (root / 'cover.png.br').write_bytes(b'not-used')
    response = client.get('/cover.png', headers={'Accept-Encoding': 'br'})
    assert response.data == b'png'
    assert 'Content-Encoding' not in response.headers
