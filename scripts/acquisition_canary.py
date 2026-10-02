#!/usr/bin/env python3
"""Exercise real extraction and read audio bytes without downloading a file.

Run explicitly or from the scheduled canary. No cookies or account secrets are
needed. A failed runner remains evidence about that runner's extraction path;
its report never claims all residential/VPS/device paths work or fail.
"""
import argparse
import json
import time
import urllib.parse

import requests
import yt_dlp


DEFAULT_VIDEO = 'dQw4w9WgXcQ'  # Same public probe as the residential-relay verifier


def probe(video_id):
    started = time.monotonic()
    with yt_dlp.YoutubeDL({'quiet': True, 'no_warnings': True, 'noplaylist': True,
                          'format': 'bestaudio/best', 'socket_timeout': 15,
                          'retries': 1, 'extractor_retries': 1}) as downloader:
        info = downloader.extract_info(f'https://www.youtube.com/watch?v={video_id}', download=False)
    url = info.get('url', '')
    if urllib.parse.urlsplit(url).scheme not in ('http', 'https'):
        raise ValueError('Extractor did not return an HTTP media URL')
    headers = {**info.get('http_headers', {}), 'Range': 'bytes=0-65535'}
    with requests.get(url, headers=headers, stream=True, timeout=(10, 20)) as response:
        response.raise_for_status()
        chunk = next(response.iter_content(chunk_size=16384), b'')
        if not chunk or response.headers.get('Content-Type', '').startswith('text/'):
            raise ValueError('Media URL did not deliver audio bytes')
    return {'status': 'passed', 'video_id': video_id, 'extractor': info.get('extractor_key'),
            'format': info.get('ext'), 'bytes_read': len(chunk),
            'elapsed_ms': round((time.monotonic()-started)*1000)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--video-id', default=DEFAULT_VIDEO)
    args = parser.parse_args()
    try:
        result = probe(args.video_id)
    except Exception as exc:
        print(json.dumps({'status': 'failed', 'error_type': type(exc).__name__}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
