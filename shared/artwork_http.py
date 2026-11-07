"""Public image transport, run only in the separately supervised HTTP child."""
from pathlib import Path

import requests

_session = None
MAX_REMOTE_PIXELS = 4_000_000


def fetch(url, target, video_id=None):
    from shared.artwork_sources import safe_image_url
    from shared.artwork import MAX_BYTES
    from PIL import Image
    global _session
    if not safe_image_url(url, video_id=video_id):
        raise ValueError('Untrusted artwork reference')
    if _session is None:
        _session = requests.Session()
        _session.trust_env = False
    _session.cookies.clear()
    try:
        with _session.get(url, stream=True, timeout=(3, 5), allow_redirects=False,
                          headers={'Accept-Encoding': 'identity'}) as response:
            result = {'status': response.status_code,
                      'retry_after': response.headers.get('Retry-After', '')[:256], 'bytes': 0}
            if response.status_code != 200:
                return result
            if response.headers.get('Content-Encoding', 'identity').lower() not in ('', 'identity'):
                raise ValueError('Compressed artwork transfer is not supported')
            expected = response.headers.get('Content-Length')
            if expected is not None and (not expected.isdecimal() or int(expected) > MAX_BYTES):
                raise ValueError('Artwork exceeds byte limit')
            with Path(target).open('wb') as output:
                for chunk in iter(lambda: response.raw.read1(64 * 1024), b''):
                    result['bytes'] += len(chunk)
                    if result['bytes'] > MAX_BYTES:
                        raise ValueError('Artwork exceeds byte limit')
                    output.write(chunk)
            if expected is not None and result['bytes'] != int(expected):
                raise ValueError('Incomplete artwork transfer')
        with Image.open(target) as image:
            if image.width * image.height > MAX_REMOTE_PIXELS:
                raise ValueError('Remote artwork exceeds pixel limit')
            image.verify()
        return result
    finally:
        _session.cookies.clear()
