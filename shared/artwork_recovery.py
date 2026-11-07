"""Conservative, resumable recovery of known-source artwork, off request paths."""
from __future__ import annotations

import hashlib
import json
import random
import logging
from pathlib import Path
import re
import threading
import time

import numpy as np
import requests
from PIL import Image

from shared.artwork import artwork_store, open_image
from shared.runtime import get_cache_dir

logger = logging.getLogger(__name__)


def perceptual_hash(image: Image.Image) -> int:
    """64 low-frequency DCT coefficients; no optional imagehash dependency."""
    pixels = np.asarray(image.convert('L').resize((32, 32), Image.Resampling.LANCZOS), dtype=float)
    basis = np.cos(np.pi / 32 * (np.arange(32) + .5)[None, :] * np.arange(8)[:, None])
    values = (basis @ pixels @ basis.T).flatten()
    threshold = np.median(values[1:])
    return sum(int(value > threshold) << i for i, value in enumerate(values))


def same_better_image(old: bytes, new: bytes) -> bool:
    a, b = open_image(old), open_image(new)
    if min(b.size) <= min(a.size):
        return False
    if abs((b.width / b.height) / (a.width / a.height) - 1) >= .01:
        return False
    return (perceptual_hash(a) ^ perceptual_hash(b)).bit_count() <= 4


class RetryLater(Exception):
    def __init__(self, seconds: float, *, contacted=True):
        self.seconds, self.contacted = seconds, contacted


class ArtworkRecovery:
    def __init__(self):
        self.stop_event = threading.Event()
        self.thread = None
        self.last_request = 0.0
        self.candidate_url = None

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self.run, name='artwork-recovery', daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()

    def fetch(self, video_id: str) -> bytes | None:
        # A fixed provider endpoint, no arbitrary URL proxy or redirects.
        if not re.fullmatch(r'[A-Za-z0-9_-]{11}', video_id):
            return None
        remaining = 1 - (time.monotonic() - self.last_request)
        if self.stop_event.wait(max(0, remaining)):
            raise RetryLater(60, contacted=False)
        self.last_request = time.monotonic()
        from shared.artwork_sources import fetch_image, ArtworkDeferred
        try:
            return fetch_image(self.candidate_url or f'https://i.ytimg.com/vi/{video_id}/maxresdefault.jpg',
                               video_id=video_id, stop=self.stop_event)
        except ArtworkDeferred as exc:
            raise RetryLater(exc.seconds, contacted=exc.contacted) from exc

    def recover(self, track) -> bool:
        from shared.audio_files import AudioProcessor
        from shared.path_resolver import resolve_local_track_path
        store = artwork_store()
        from shared.artwork_sources import observed
        personal = store.effective_ref(track.id)
        if personal and personal.get('account') and personal['source'] in ('manual', 'none'):
            return False
        ref = store.ref(track.id)
        options = observed(getattr(track, 'youtube_id', None))
        basis = hashlib.sha256(json.dumps([2, ref['hash'] if ref else None,
                                          getattr(track, 'cover_source', None),
                                          getattr(track, 'youtube_id', None), options], sort_keys=True).encode()).hexdigest()
        with store.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS recovery_basis (track_id TEXT PRIMARY KEY, basis TEXT, video_id TEXT)')
            previous = db.execute('SELECT basis FROM recovery_basis WHERE track_id=?', (track.id,)).fetchone()
            status = db.execute('SELECT * FROM recovery WHERE track_id=?', (track.id,)).fetchone()
            if previous and previous[0] != basis:
                status = None
            db.execute('INSERT INTO recovery_basis VALUES (?,?,?) ON CONFLICT(track_id) DO UPDATE SET '
                       'basis=excluded.basis,video_id=excluded.video_id WHERE basis!=excluded.basis',
                       (track.id, basis, getattr(track, 'youtube_id', None)))
        if status and status['next_try'] > time.time():
            return False
        if status and status['state'] == 'failed':
            status = None  # a new bounded recovery window, not permanent failure
        revision = ref['revision'] if ref else 0
        source = getattr(track, 'cover_source', None)
        if source == 'none' or (ref and ref['source'] == 'none'):
            self.finish(track.id, 'skipped', 'explicitly removed')
            return False
        # Prefer the preserved original, then legacy cache, then embedded bytes.
        old = Path(store.path(track.id)).read_bytes() if store.path(track.id) else None
        # Embedded art is authoritative when no master exists: a legacy cache
        # can predate a manual edit. Only promote a matching larger cache copy.
        if not old:
            local = resolve_local_track_path(track)
            if local and not str(local).startswith('http'):
                old = AudioProcessor.extract_cover_art(local)
        local_candidates = [get_cache_dir() / 'covers' / f'{track.id}.jpg']
        for path in local_candidates:
            if path.is_file():
                try:
                    data = path.read_bytes()
                    if not old or same_better_image(old, data):
                        old = data
                except (OSError, ValueError):
                    pass
        if not old:
            self.finish(track.id, 'skipped', 'no local reference image')
            return False
        digest = store.put(old)
        if not store.bind(track.id, digest, ref['source'] if ref else source, expected_revision=revision):
            return False
        ref = store.ref(track.id)
        # Unknown/manual provenance never triggers external replacement. The
        # downloader's embedded marker is qualified by the track's youtube source.
        protected = source != 'youtube' or ref['source'] in ('manual', 'none')
        dimensions = open_image(old).size
        larger = [c for c in options if min(c['width'], c['height']) > min(dimensions)]
        if protected or (max(dimensions) >= 1280 and not larger):
            self.finish(track.id, 'complete', 'preserved locally')
            return revision != ref['revision']
        video_id = getattr(track, 'youtube_id', None)
        if not video_id:
            self.finish(track.id, 'skipped', 'missing source identity')
            return False
        from shared.artwork_sources import safe_image_url
        self.candidate_url = next((c['url'] for c in larger
                                   if safe_image_url(c['url'], video_id=video_id)), None)
        attempts = (status['attempts'] if status and status['state'] == 'pending' else 0) + 1
        # Persist before I/O: restarting cannot reset the retry budget.
        self.finish(track.id, 'pending', 'fetching', attempts, time.time() + 60)
        try:
            new = self.fetch(video_id)
            if new and same_better_image(old, new):
                changed = store.bind(track.id, store.put(new), 'youtube', expected_revision=ref['revision'])
                self.finish(track.id, 'complete', 'improved' if changed else 'edited concurrently', attempts)
                return changed
            self.finish(track.id, 'complete', 'no confirmed improvement', attempts)
        except (requests.RequestException, ValueError, OSError, RetryLater) as exc:
            if isinstance(exc, RetryLater) and not exc.contacted:
                attempts -= 1
            delay = exc.seconds if isinstance(exc, RetryLater) else 60 * (2 ** (min(attempts, 3) - 1)) * random.uniform(1, 1.25)
            self.finish(track.id, 'failed' if attempts >= 3 else 'pending', type(exc).__name__, attempts, time.time() + (max(delay, 86400) if attempts >= 3 else delay))
        return revision != ref['revision']

    @staticmethod
    def finish(track_id, state, detail, attempts=0, next_try=0):
        if not next_try and state in ('complete', 'skipped', 'failed'):
            next_try = time.time() + (86400 if state == 'failed' else 30 * 86400)
        with artwork_store().connect() as db:
            db.execute('INSERT INTO recovery VALUES (?, ?, ?, ?, ?) ON CONFLICT(track_id) DO UPDATE SET '
                       'state=excluded.state, attempts=excluded.attempts, next_try=excluded.next_try, detail=excluded.detail',
                       (track_id, state, attempts, next_try, detail))

    def run(self):
        from shared.user_context import user_context
        # Let startup and the first playback settle; a single worker is below
        # the two-task ceiling and avoids competing disk scans across accounts.
        while not self.stop_event.wait(30):
            try:
                from shared.api import get_user_core, emit_to_user
                from shared.users import list_users
                cores = []
                for account in list_users():
                    with user_context(account['id']):
                        cores.append((account['id'], get_user_core(account['id'])))
                with artwork_store().connect() as db:
                    finished = {row[0] for row in db.execute(
                        'SELECT track_id FROM recovery WHERE next_try>?', (time.time(),))}
                started = time.monotonic()
                for uid, core in cores:
                    changed = False
                    last_notify = time.monotonic()
                    with user_context(uid):
                        from shared.artwork_sources import pending_selections, adopt
                        identities = {track.id: getattr(track, 'youtube_id', None)
                                      for track in getattr(core.library.metadata, 'tracks', ())}
                        selections = pending_selections(identities, video_ids=identities)
                        for track in list(getattr(core.library.metadata, 'tracks', ())):
                            if track.id in selections:
                                choice = selections[track.id]
                                changed = adopt(track.id, getattr(track, 'youtube_id', None), choice['token'], stop=self.stop_event) or changed
                            if track.id in finished:
                                continue
                            if self.stop_event.wait(.05):
                                return
                            try:
                                changed = self.recover(track) or changed
                                if changed and time.monotonic() - last_notify >= 30:
                                    emit_to_user('library_updated', payload={'cover_changed': True})
                                    changed = False
                                    last_notify = time.monotonic()
                            except Exception:
                                logger.exception('Artwork recovery failed for %s', track.id)
                                self.finish(track.id, 'failed', 'local preservation error')
                        if changed:
                            emit_to_user('library_updated', payload={'cover_changed': True})
                with artwork_store().connect() as db:
                    counts = dict(db.execute('SELECT state, count(*) FROM recovery GROUP BY state').fetchall())
                    total = db.execute('SELECT coalesce(sum(bytes), 0) FROM objects').fetchone()[0]
                logger.debug('Artwork recovery: states=%s stored_bytes=%s elapsed=%.2fs', counts, total, time.monotonic() - started)
            except Exception:
                logger.exception('Artwork recovery sweep failed')


recovery = ArtworkRecovery()
