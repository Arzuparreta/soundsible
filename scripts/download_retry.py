"""Downloads that ride out a flaky network instead of failing a whole CI run.

Maven Central's CDN and GitHub Pages occasionally answer a healthy URL with a
404, a reset connection or a truncated body. Every attempt here goes through
the same checks a single download had — size, checksum, caller validation —
so retrying can only ever accept what one clean attempt would have accepted.
Mirrors are tried in turn, which is safe only because the caller pins what
the bytes must be.
"""
from __future__ import annotations

import hashlib
from http.client import HTTPException
import random
import sys
import time
from typing import Callable, Optional, Sequence
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

#: Attempts per download, spread over about a minute of backoff.
ATTEMPTS = 6

sleep = time.sleep


class Rejected(Exception):
    """A response that arrived but is not the one asked for: retried."""


def fetch(
    urls: Sequence[str],
    *,
    max_bytes: int,
    sha256: Optional[str] = None,
    validate: Optional[Callable[[object, bytes], None]] = None,
    timeout: float = 60,
    attempts: int = ATTEMPTS,
    what: str = "download",
) -> bytes:
    """The body of the first attempt that passes every check.

    `validate(response, body)` raises `Rejected` for a response that should
    be retried. A checksum mismatch is retried too (a truncated or corrupted
    transfer) and reported as one when every attempt gives the wrong bytes.
    """
    last: Exception | None = None
    mismatched = False
    for attempt in range(attempts):
        url = urls[attempt % len(urls)]
        try:
            with urlopen(url, timeout=timeout) as response:
                body = response.read(max_bytes + 1)
                if len(body) > max_bytes:
                    raise Rejected(f"{what} is larger than {max_bytes} bytes")
                if sha256 is not None and hashlib.sha256(body).hexdigest() != sha256:
                    mismatched = True
                    raise Rejected(f"{what} checksum mismatch")
                if validate is not None:
                    validate(response, body)
                return body
        except (Rejected, HTTPError, URLError, HTTPException, OSError) as error:
            last = error
            if attempt + 1 == attempts:
                break
            delay = min(30.0, 2.0 ** (attempt + 1)) + random.uniform(0, 1)
            print(f"{what}: attempt {attempt + 1}/{attempts} from {url} failed ({error}); retrying in {delay:.0f}s",
                  file=sys.stderr)
            sleep(delay)
    if mismatched and isinstance(last, Rejected):
        raise RuntimeError(f"{what} checksum mismatch after {attempts} attempts")
    raise RuntimeError(f"{what} failed after {attempts} attempts: {last}")
