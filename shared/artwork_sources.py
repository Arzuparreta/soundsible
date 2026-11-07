"""Durable public observations and account-bound, authenticated selections.

Images remain optional. No client-supplied image URL becomes fetch authority.
"""
import base64
import hashlib
import hmac
import math
from email.utils import parsedate_to_datetime
import json
import os
import tempfile
import re
import threading
import time
import uuid
from urllib.parse import urlsplit

import requests

from shared.runtime import get_config_dir
from shared.user_context import require_user_id

_key_lock = threading.Lock()
IMAGE_DEADLINE_SEC = 15


class ArtworkDeferred(requests.RequestException):
    def __init__(self, seconds, *, contacted=False):
        super().__init__('Artwork provider cooling down')
        self.seconds, self.contacted = seconds, contacted


def retry_delay(raw):
    try:
        delay = float(raw)
    except (ValueError, TypeError):
        try:
            delay = parsedate_to_datetime(raw).timestamp() - time.time()
        except (ValueError, TypeError, OverflowError):
            delay = 60
    return max(1, min(delay, 86400)) if math.isfinite(delay) else 60



def safe_image_url(url, *, video_id=None):
    if not isinstance(url, str) or len(url) > 2048:
        return False
    try:
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443):
            return False
        if video_id:
            return (parsed.hostname in ('i.ytimg.com', 'img.youtube.com')
                    and re.fullmatch(r'[A-Za-z0-9_-]{11}', video_id) is not None
                    and re.fullmatch(r'/vi(?:_webp)?/' + re.escape(video_id)
                                     + r'/(?:maxresdefault|hq720|sddefault|hqdefault|mqdefault|default)\.(?:jpg|webp)', parsed.path) is not None)
        return (parsed.hostname == 'cdn-images.dzcdn.net'
                and re.fullmatch(r'/images/cover/[0-9a-f]{32}/[0-9]+x[0-9]+-[^/]+\.jpg', parsed.path) is not None
                and not parsed.query and not parsed.fragment)
    except ValueError:
        return False


def observe(video_id, candidates):
    """Persist only useful bounded metadata already paid for by resolution."""
    from shared.artwork import artwork_store
    values = [c for c in candidates[:8] if safe_image_url(c.get('url'), video_id=video_id)]
    if not values:
        return
    # This is optional metadata on the audio resolver's critical path. A busy
    # index must be a miss, never SQLite sleeping in that caller for 30 seconds.
    with artwork_store().connect(timeout=0) as db:
        db.execute('CREATE TABLE IF NOT EXISTS source_images (video_id TEXT PRIMARY KEY, candidates TEXT)')
        changed = db.execute('INSERT INTO source_images VALUES (?,?) ON CONFLICT(video_id) '
                   'DO UPDATE SET candidates=excluded.candidates WHERE candidates!=excluded.candidates',
                   (video_id, json.dumps(values, sort_keys=True))).rowcount
        if changed and db.execute("SELECT 1 FROM sqlite_master WHERE name='recovery_basis'").fetchone():
            db.execute('UPDATE recovery SET next_try=0 WHERE track_id IN '
                       '(SELECT track_id FROM recovery_basis WHERE video_id=?)', (video_id,))


def observed(video_id):
    from shared.artwork import artwork_store
    with artwork_store().connect() as db:
        exists = db.execute("SELECT 1 FROM sqlite_master WHERE name='source_images'").fetchone()
        row = db.execute('SELECT candidates FROM source_images WHERE video_id=?', (video_id,)).fetchone() if exists else None
    return json.loads(row[0]) if row else []


def _key():
    path = get_config_dir() / '.artwork-selection-key'
    with _key_lock:
        try:
            return path.read_bytes()
        except FileNotFoundError:
            path.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix='.artwork-key-', dir=path.parent)
            try:
                with os.fdopen(fd, 'wb') as stream:
                    value = os.urandom(32)
                    stream.write(value)
                    stream.flush()
                    os.fsync(stream.fileno())
                try:
                    os.link(temporary, path)
                except FileExistsError:
                    return path.read_bytes()
                return value
            finally:
                os.unlink(temporary)



def selection(video_id, catalog_id, url):
    """Called only with server-validated provider data at the intake boundary."""
    if not safe_image_url(url):
        return None
    from shared.artwork import artwork_store
    with artwork_store().connect() as db:
        db.execute('CREATE TABLE IF NOT EXISTS selection_sequence (singleton INTEGER PRIMARY KEY,seq INTEGER)')
        db.execute('INSERT OR IGNORE INTO selection_sequence VALUES (1,0)')
        db.execute('UPDATE selection_sequence SET seq=seq+1 WHERE singleton=1')
        order = db.execute('SELECT seq FROM selection_sequence WHERE singleton=1').fetchone()[0]
    body = json.dumps([require_user_id(), video_id, catalog_id, url, order], separators=(',', ':')).encode()
    payload = base64.urlsafe_b64encode(body).decode()
    return payload + '.' + hmac.new(_key(), body, hashlib.sha256).hexdigest()


def verify(token, video_id):
    try:
        if not isinstance(token, str) or len(token) > 4096:
            return None
        payload, signature = token.split('.')
        body = base64.b64decode(payload, altchars=b'-_', validate=True)
        if not hmac.compare_digest(signature, hmac.new(_key(), body, hashlib.sha256).hexdigest()):
            return None
        account, video, catalog, url, order = json.loads(body)
        if account == require_user_id() and video == video_id and safe_image_url(url):
            return url
    except (ValueError, TypeError, OSError):
        pass
    return None


def fetch_image(url, *, video_id=None, stop=None):
    """One pooled public-CDN lane, absolute budget and persisted provider pause."""
    from shared.artwork import artwork_store
    from shared.artwork_worker import http_worker, ImageBusy
    if not safe_image_url(url, video_id=video_id):
        raise ValueError('Untrusted artwork reference')
    deadline = time.monotonic() + IMAGE_DEADLINE_SEC
    host, store = urlsplit(url).hostname, artwork_store()
    with store.connect() as db:
        db.execute('CREATE TABLE IF NOT EXISTS image_backoff (host TEXT PRIMARY KEY,next_try REAL)')
        db.execute('CREATE TABLE IF NOT EXISTS image_absent (url TEXT PRIMARY KEY,next_try REAL)')
        pause = db.execute('SELECT next_try FROM image_backoff WHERE host=?', (host,)).fetchone()
        absent = db.execute('SELECT next_try FROM image_absent WHERE url=?', (url,)).fetchone()
    if absent and absent[0] > time.time():
        return None
    if pause and pause[0] > time.time():
        raise ArtworkDeferred(pause[0] - time.time())
    try:
        result = http_worker.render(url, None, 0, False, deadline=deadline,
                                    staging_dir=store.cache / '.image-http', operation='fetch',
                                    video_id=video_id, stop=stop)
    except ImageBusy as exc:
        raise ArtworkDeferred(1) from exc
    except OSError as exc:
        raise requests.Timeout('Artwork transport failed or exceeded its deadline') from exc
    if result['status'] in (429, 503):
        delay = retry_delay(result['retry_after'] or '60')
        with store.connect() as db:
            db.execute('INSERT INTO image_backoff VALUES (?,?) ON CONFLICT(host) '
                       'DO UPDATE SET next_try=excluded.next_try', (host, time.time() + delay))
        raise ArtworkDeferred(delay, contacted=True)
    if result['status'] == 404:
        with store.connect() as db:
            db.execute('INSERT INTO image_absent VALUES (?,?) ON CONFLICT(url) '
                       'DO UPDATE SET next_try=excluded.next_try', (url, time.time() + 30 * 86400))
        return None
    if result['status'] != 200:
        raise requests.HTTPError('Artwork HTTP status ' + str(result['status']))
    return result['data']


def schedule_selection(track_id, video_id, token):
    """Persist intent without doing I/O. Replay cannot supersede newer intent."""
    from shared.artwork import artwork_store
    if not verify(token, video_id):
        return False
    account = require_user_id()
    order = json.loads(base64.urlsafe_b64decode(token.split('.')[0]))[4]
    with artwork_store().connect() as db:
        db.execute('CREATE TABLE IF NOT EXISTS selections (account TEXT,track_id TEXT,video_id TEXT,'
                   'token TEXT,attempts INTEGER,next_try REAL,issued INTEGER,lease TEXT,PRIMARY KEY(account,track_id))')
        db.execute('INSERT INTO selections VALUES (?,?,?,?,0,0,?,NULL) ON CONFLICT(account,track_id) '
                   'DO UPDATE SET token=excluded.token,video_id=excluded.video_id,attempts=0,next_try=0,'
                   'issued=excluded.issued,lease=NULL WHERE issued<excluded.issued',
                   (account, track_id, video_id, token, order))
    return True


def adopt(track_id, video_id, token, *, stop=None):
    """One leased attempt; publish the override and complete it atomically."""
    from shared.artwork import artwork_store
    url = verify(token, video_id)
    if not url:
        return False
    schedule_selection(track_id, video_id, token)
    store, account, lease = artwork_store(), require_user_id(), uuid.uuid4().hex
    with store.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        pending = db.execute('SELECT attempts,next_try,token FROM selections WHERE account=? AND track_id=?',
                             (account, track_id)).fetchone()
        if pending['token'] != token or pending['next_try'] > time.time():
            return False
        current = db.execute('SELECT source,revision FROM overrides WHERE account=? AND track_id=?',
                             (account, track_id)).fetchone()
        original = db.execute('SELECT source FROM refs WHERE track_id=?', (track_id,)).fetchone()
        if ((current and current['source'] in ('manual', 'none'))
                or (not current and original and original['source'] in ('manual', 'none'))):
            db.execute('UPDATE selections SET attempts=-1,next_try=1e20,lease=NULL '
                       'WHERE account=? AND track_id=?', (account, track_id))
            return False
        revision = current['revision'] if current else 0
        attempts = pending['attempts'] + 1
        db.execute('UPDATE selections SET attempts=?,next_try=?,lease=? WHERE account=? AND track_id=?',
                   (attempts, time.time() + 60, lease, account, track_id))
    delay = 86400 if attempts >= 3 else 60 * 2 ** attempts
    try:
        data = fetch_image(url, stop=stop)
        if data and store.bind_override(track_id, store.put(data), 'catalog', automatic=True,
                                        expected_revision=revision, selection_token=token, selection_lease=lease):
            return True
    except ArtworkDeferred as exc:
        delay = max(delay, exc.seconds)
        if not exc.contacted:
            attempts -= 1
    except (requests.RequestException, ValueError, OSError):
        pass
    with store.connect() as db:
        db.execute('UPDATE selections SET attempts=?,next_try=?,lease=NULL '
                   'WHERE account=? AND track_id=? AND token=? AND lease=?',
                   (attempts, time.time() + delay, account, track_id, token, lease))
    return False


def pending_selections(valid_ids=None, *, video_ids=None):
    """Keyset-paged cleanup ensures orphaned selections cannot starve a batch."""
    from shared.artwork import artwork_store
    account, found, cursor = require_user_id(), {}, ''
    with artwork_store().connect() as db:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE name='selections'").fetchone():
            return {}
        for _ in range(8):  # bounded cleanup; later sweeps continue removing old rows
            rows = db.execute('SELECT track_id,video_id,token FROM selections '
                              'WHERE account=? AND next_try<=? AND track_id>? ORDER BY track_id LIMIT 64',
                              (account, time.time(), cursor)).fetchall()
            if not rows:
                break
            for row in rows:
                cursor = row['track_id']
                if ((valid_ids is not None and row['track_id'] not in valid_ids)
                        or (video_ids is not None and video_ids.get(row['track_id']) != row['video_id'])):
                    db.execute('DELETE FROM selections WHERE account=? AND track_id=? AND token=?',
                               (account, row['track_id'], row['token']))
                    continue
                found[row['track_id']] = dict(row)
                if len(found) >= 8:
                    return found
    return found
