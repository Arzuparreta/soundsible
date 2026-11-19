"""Bounded journal deltas from committed SQLite rows and annotation cursors."""
from hashlib import sha256
import json
import time

from flask import current_app
from flask.json.provider import DefaultJSONProvider

from shared.api import library_deltas as history
from shared.library_fingerprint import TRACK_FIELDS
from shared.loudness import LoudnessStore, annotate_tracks

MAX_BASES = 256
MAX_PER_ACCOUNT = 4
TTL = 86400
PROJECTION = 'sqlite-catalog'
# Every public track has these ASCII keys and at least one byte per JSON value.
# A delta smaller than this bound is certainly smaller than the full response.
MIN_TRACK_BYTES = 1 + sum(len(name) + 5 for name in TRACK_FIELDS)


def _table(db):
    db.execute('CREATE TABLE IF NOT EXISTS incremental_bases ('
               'account TEXT,revision TEXT,created REAL,proof TEXT,PRIMARY KEY(account,revision))')


def load_base(account, revision):
    with history.connection() as db:
        _table(db)
        row = db.execute('SELECT proof FROM incremental_bases WHERE account=? AND revision=? AND created>=?',
                         (account, revision, time.time() - TTL)).fetchone()
        return json.loads(row[0]) if row else None


def header_digests(headers):
    """Digest each rendered field for comparison with a client's saved base."""
    return {key: history.digest(value).hex() for key, value in headers.items()}


def remember(account, revision, state, digests):
    if len(account.encode()) > 256:
        return
    proof = json.dumps({**state, 'headers': digests, 'projection': PROJECTION})
    if len(proof.encode()) > 8192:
        return
    with history.connection() as db:
        db.execute('BEGIN IMMEDIATE')
        _table(db)
        db.execute('DELETE FROM incremental_bases WHERE created<?', (time.time() - TTL,))
        db.execute('INSERT INTO incremental_bases VALUES (?,?,?,?) ON CONFLICT(account,revision) '
                   'DO UPDATE SET created=excluded.created,proof=excluded.proof', (account, revision, time.time(), proof))
        db.execute('DELETE FROM incremental_bases WHERE account=? AND revision NOT IN '
                   '(SELECT revision FROM incremental_bases WHERE account=? ORDER BY created DESC,rowid DESC LIMIT ?)',
                   (account, account, MAX_PER_ACCOUNT))
        db.execute('DELETE FROM incremental_bases WHERE rowid NOT IN '
                   '(SELECT rowid FROM incremental_bases ORDER BY created DESC,rowid DESC LIMIT ?)', (MAX_BASES,))


def prepare(source, artwork):
    """Bind one committed projection to its annotation cursors."""
    provider = current_app.json
    if (source is None or type(provider) is not DefaultJSONProvider or provider.compact is False
            or (provider.compact is None and current_app.debug)):
        return None
    return {'source': source, 'art': artwork.change_state() if source['tracks'] else None,
            'loud': LoudnessStore().change_state() if source['tracks'] else None}


def annotations_current(artwork, state):
    return not state['source']['tracks'] or (
        artwork.change_state() == state['art'] and LoudnessStore().change_state() == state['loud']
    )


def revision_for(account, state):
    # The write revision advances on no-op saves. Only content, ordering and
    # projection dependencies select an HTTP representation.
    art, loud = state['art'], state['loud']
    source = state['source']
    return sha256(history.encoded((PROJECTION, account, source['fingerprint'], source['cursor'][:2],
                                   source['credits'][:2], source['ordering'],
                                   art['token'] if art else None, loud['token'] if loud else None))).hexdigest()


def try_delta(db, artwork, account, base_revision, state):
    if not state['source']['tracks'] or not base_revision or len(base_revision) > 128:
        return None
    base = load_base(account, base_revision)
    if base is None or base.get('projection') != PROJECTION or base['art'] is None:
        return None
    artwork_ids = artwork.changed_tracks(base['art'], state['art'])
    identities = LoudnessStore().changed_identities(base['loud'], state['loud'])
    if artwork_ids is None or identities is None:
        return None
    affected = db.public_changes(base['source'], state['source'], artwork_ids, identities)
    if affected is None:
        return None
    upserts, removed, order, headers = affected
    if headers is None:
        fields, digests = {}, base['headers']
    else:
        digests = header_digests(headers)
        fields = {name: headers[name] for name, digest in digests.items()
                  if digest != base['headers'].get(name)}
    if not annotate_tracks(upserts, selected=True):
        return None
    artwork.annotate(upserts)
    delta = {'kind': 'delta', 'base_revision': base_revision, 'revision': revision_for(account, state),
             'upserts': upserts, 'removed': removed, 'fields': fields}
    if order is not None:
        delta['order'] = order
    if db.public_source() != state['source'] or not annotations_current(artwork, state):
        return None
    response = current_app.json.response(delta)
    if not db.public_track_count_exceeds(len(response.get_data()) // MIN_TRACK_BYTES):
        return None
    remember(account, delta['revision'], state, digests)
    response.headers['Cache-Control'] = 'private, no-store'
    return response
