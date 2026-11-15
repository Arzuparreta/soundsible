"""Podcast artwork: fetched once from its publisher, kept as bounded JPEGs.

Show and episode artwork lives on whatever host a publisher picked. The engine
fetches it, never the page: some hosts refuse an image whose Referer names
another site (esRadio's s1.staticld.com answers 403), and browsers send that
Referer for CSS background images whatever the page's referrer policy says.

Hosts also label their images badly. Anchor's CDN calls a JPEG `image/jpg`,
COPE serves its show artwork as `application/octet-stream`. A browser draws
either, so the engine goes by the bytes and ignores the header.

The publisher's image is fetched once and redrawn as a JPEG of at most
`MASTER` pixels on a side. Every smaller size the UI asks for is drawn from
that master, never fetched again. Masters and sizes are variants in the
library's artwork cache (`shared.artwork_variants`): one disk quota, one LRU,
and decoding in the isolated image worker, as for library covers. A variant
older than `FRESH_SEC` is drawn again, so artwork a publisher replaces at the
same URL comes through.
"""

from __future__ import annotations

import hashlib
import logging
import shutil
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, List

import requests

from shared.artwork import MAX_BYTES, SIZES
from shared.podcast_rss import assert_safe_http_url

log = logging.getLogger(__name__)

TRANSFORM = "podcast-v1"
MASTER = SIZES[-1]
DEFAULT_SIZE = 640
FRESH_SEC = 30 * 24 * 3600
# A URL whose publisher has no usable image is not asked again for this long.
FAILURE_SEC = 15 * 60
_MAX_FAILURES = 1024
_MAX_REDIRECTS = 3
_DEADLINE_SEC = 30
# Misses waiting on a publisher, and sizes waiting on the image worker, at
# once. A show's first screen asks for a dozen covers together; the rest wait
# here instead of overflowing the worker queue the library shares.
_FETCHES = threading.BoundedSemaphore(4)
_DRAWS = threading.BoundedSemaphore(4)
_HEADERS = {"User-Agent": "SoundsiblePodcast/1.0", "Accept": "image/*"}
_RASTER = (b"\xff\xd8\xff", b"\x89PNG\r\n\x1a\n", b"GIF87a", b"GIF89a")

_failures: Dict[str, float] = {}
_flights: Dict[str, List] = {}
_flights_guard = threading.Lock()


class Unavailable(Exception):
    """The publisher has no usable image at this URL."""


class Busy(OSError):
    """Too much artwork work queued to start this before its deadline."""


def _is_image(head: bytes) -> bool:
    """Whether the first bytes are JPEG, PNG, GIF, WebP or ISO-BMFF (AVIF).
    The worker decides the rest; this stops an HTML error page early."""
    return (head.startswith(_RASTER)
            or head[:4] == b"RIFF" and head[8:12] == b"WEBP"
            or head[4:8] == b"ftyp")


def _fetch(url: str, target: Path) -> None:
    """Writes the image at `url` to `target`. Every redirect is checked like
    the first URL, so a feed cannot bounce the engine onto its own network."""
    for _ in range(_MAX_REDIRECTS + 1):
        try:
            assert_safe_http_url(url)
        except ValueError as exc:
            raise Unavailable(str(exc)) from exc
        with requests.get(url, headers=_HEADERS, stream=True, timeout=(5, 20), allow_redirects=False) as resp:
            if resp.is_redirect:
                url = requests.compat.urljoin(url, resp.headers.get("Location", ""))
                continue
            if resp.status_code != 200:
                raise Unavailable(f"HTTP {resp.status_code}")
            size = resp.headers.get("Content-Length")
            if size is not None and (not size.isdigit() or int(size) > MAX_BYTES):
                raise Unavailable("Artwork exceeds byte limit")
            written, head = 0, b""
            with target.open("wb") as out:
                for chunk in resp.iter_content(chunk_size=65536):
                    if len(head) < 16:
                        head += chunk[:16]
                        if len(head) >= 16 and not _is_image(head):
                            raise Unavailable("Not an image")
                    written += len(chunk)
                    if written > MAX_BYTES:
                        raise Unavailable("Artwork exceeds byte limit")
                    out.write(chunk)
            if not _is_image(head):
                raise Unavailable("Not an image")
            return
    raise Unavailable("Too many redirects")


@contextmanager
def _slot(semaphore: threading.BoundedSemaphore, deadline: float):
    if not semaphore.acquire(timeout=max(0, deadline - time.monotonic())):
        raise Busy("Podcast artwork queue deadline exceeded")
    try:
        yield
    finally:
        semaphore.release()


@contextmanager
def _single_flight(key: str, deadline: float):
    """One request draws a variant; the others wait and then read it."""
    with _flights_guard:
        entry = _flights.setdefault(key, [threading.Lock(), 0])
        entry[1] += 1
    try:
        with _slot(entry[0], deadline):
            yield
    finally:
        with _flights_guard:
            entry[1] -= 1
            if not entry[1]:
                _flights.pop(key, None)


def _cache():
    from shared.artwork import artwork_store

    return artwork_store().variants


def _render(source: Path, output, size: int, square: bool, staging: Path, deadline: float) -> None:
    from shared.artwork_worker import ImageBusy, generate

    try:
        generate(source, output, size, square, deadline=deadline, staging_dir=staging)
    except ImageBusy as exc:
        raise Busy(str(exc)) from exc


def _open(cache, digest: str, url: str, size: int, square: bool, deadline: float):
    name = f"{digest}-{size}-{'square' if square else 'original'}-{TRANSFORM}.jpg"
    staging_root = cache.root / ".image-workers"
    master = size == MASTER and not square

    def draw(output) -> None:
        from shared.artwork_staging import staging

        if master:
            with _slot(_FETCHES, deadline), staging(staging_root) as source:
                _fetch(url, source)
                try:
                    _render(source, output, MASTER, False, staging_root, deadline)
                except Busy:
                    raise
                except Exception as exc:
                    # The worker refuses bytes it cannot decode, or an image past
                    # its pixel limit: the publisher's file, not the engine.
                    raise Unavailable(f"Undecodable artwork: {type(exc).__name__}") from exc
            return
        original = _open(cache, digest, url, MASTER, False, deadline)
        with original.file, staging(staging_root) as source:
            with source.open("wb") as copy:
                shutil.copyfileobj(original.file, copy, 64 * 1024)
            with _slot(_DRAWS, deadline):
                _render(source, output, size, square, staging_root, deadline)

    with _single_flight(name, deadline):
        variant = cache.open(name, draw, deadline=deadline)
        if time.time() - variant.modified <= FRESH_SEC:
            return variant
        variant.file.close()
        (cache.root / name).unlink(missing_ok=True)
        return cache.open(name, draw, deadline=deadline)


def _remember_failure(url: str) -> None:
    _failures.pop(url, None)
    _failures[url] = time.monotonic() + FAILURE_SEC
    while len(_failures) > _MAX_FAILURES:
        _failures.pop(next(iter(_failures)))


def open_artwork(url: str, size: int = DEFAULT_SIZE, square: bool = False):
    """The artwork at `url`, at most `size` pixels on a side, as a cache
    `Variant` whose open file the caller closes.

    Raises `Unavailable` when the publisher has no usable image there, and
    `OSError` (`Busy` among them) when it could not be drawn right now."""
    if size not in SIZES:
        raise ValueError("Invalid artwork size")
    expires = _failures.get(url)
    if expires is not None:
        if expires > time.monotonic():
            raise Unavailable("Artwork failed recently")
        _failures.pop(url, None)
    digest = hashlib.sha256(f"podcast-artwork\n{url}".encode()).hexdigest()
    try:
        return _open(_cache(), digest, url, size, square, time.monotonic() + _DEADLINE_SEC)
    except Unavailable as exc:
        log.info("Podcast artwork unavailable (%s): %s", exc, url)
        _remember_failure(url)
        raise
