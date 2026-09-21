"""Journal-driven library deltas; only bounded proofs are retained on disk."""
from copy import deepcopy
from hashlib import sha256
import json
import time

from flask import current_app
from flask.json.provider import DefaultJSONProvider

from shared.api import library_deltas as history
from shared.library_fingerprint import fingerprint, HEADER_FIELDS, TRACK_FIELDS
from shared.database import DatabaseManager
from shared.loudness import LoudnessStore, annotate_tracks
from shared.models import LibraryMetadata, Track

MAX_BASES = 256
MAX_PER_ACCOUNT = 4
TTL = 86400
# Every public track has these ASCII keys and at least one byte per JSON value.
# A delta smaller than this bound is certainly smaller than the full response.
MIN_TRACK_BYTES = 1 + sum(len(name) + 5 for name in TRACK_FIELDS)


def supported(lib):
    provider = current_app.json
    return (type(getattr(lib, 'metadata', None)) is LibraryMetadata
            and bool(lib.metadata.tracks)
            and isinstance(getattr(lib, 'db', None), DatabaseManager)
            and type(provider) is DefaultJSONProvider
            and provider.compact is not False
            and not (provider.compact is None and current_app.debug))


def _table(db):
    db.execute('CREATE TABLE IF NOT EXISTS incremental_bases ('
               'account TEXT,revision TEXT,created REAL,proof TEXT,PRIMARY KEY(account,revision))')


def load_base(account, revision):
    with history.connection() as db:
        _table(db)
        row = db.execute('SELECT proof FROM incremental_bases WHERE account=? AND revision=? AND created>=?',
                         (account, revision, time.time() - TTL)).fetchone()
        return json.loads(row[0]) if row else None


def remember(account, revision, state, headers):
    if len(account.encode()) > 256:
        return
    proof = json.dumps({**state, 'headers': {key: history.digest(value).hex() for key, value in headers.items()}})
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


def prepare(lib, artwork, dependencies, source_fingerprint):
    """Tie the actual public model to a committed source and annotation cursors."""
    if not supported(lib) or dependencies is None:
        return None
    source = lib.db.public_source()
    if source is None or source['fingerprint'] != source_fingerprint:
        return None
    art = artwork.change_state()
    loud = LoudnessStore().change_state()
    if dependencies != ((art['token'], loud['token']) if lib.metadata.tracks else ()):
        return None
    state = {'source': source, 'art': art, 'loud': loud}
    return state


def still_current(lib, artwork, state):
    return (lib.db.public_source() == state['source']
            and artwork.change_state() == state['art']
            and LoudnessStore().change_state() == state['loud'])


def revision_for(account, state):
    # Weak ETags are opaque validators, not a promise to hash serialized bytes.
    return sha256(history.encoded(('library-dependencies', account, state['source']['fingerprint'],
                                 state['art']['token'], state['loud']['token']))).hexdigest()


def try_delta(lib, artwork, account, base_revision, dependencies, source_fingerprint=None):
    if not supported(lib) or not base_revision or len(base_revision) > 128:
        return None
    base = load_base(account, base_revision)
    if base is None:
        return None
    if source_fingerprint is None:
        source_fingerprint = fingerprint(lib.metadata)
    state = prepare(lib, artwork, dependencies, source_fingerprint)
    if state is None:
        return None
    artwork_ids = artwork.changed_tracks(base['art'], state['art'])
    identities = LoudnessStore().changed_identities(base['loud'], state['loud'])
    if artwork_ids is None or identities is None:
        return None
    affected = lib.db.public_changes(base['source'], state['source'], artwork_ids, identities)
    if affected is None:
        return None
    positions, removed, order = affected
    copied = {}
    for track_id, position in positions.items():
        track = lib.metadata.tracks[position]
        if type(track) is not Track or track.id != track_id:
            return None
        copied[position] = track.to_public_dict()
    headers = {name: deepcopy(getattr(lib.metadata, name)) for name in HEADER_FIELDS}
    # Validate the exact detached rows/headers we will return. Substituting
    # them also detects mutations during copying, even if the live row reverts.
    if fingerprint(lib.metadata, public_tracks=copied, public_headers=headers) != state['source']['fingerprint']:
        return None
    upserts = [copied[position] for position in sorted(copied)]
    if not annotate_tracks(upserts, selected=True):
        return None
    artwork.annotate(upserts)
    delta = {'kind': 'delta', 'base_revision': base_revision, 'revision': revision_for(account, state),
             'upserts': upserts, 'removed': removed,
             'fields': {name: value for name, value in headers.items()
                        if history.digest(value).hex() != base['headers'].get(name)}}
    if order is not None:
        delta['order'] = order
    if not still_current(lib, artwork, state):
        return None
    response = current_app.json.response(delta)
    if len(response.get_data()) >= len(lib.metadata.tracks) * MIN_TRACK_BYTES:
        return None
    remember(account, delta['revision'], state, headers)
    from shared.api.library_revision import validators
    key = sha256(repr((account, state['source']['fingerprint'], dependencies)).encode()).hexdigest()
    validators.put(key, delta['revision'])
    response.headers['Cache-Control'] = 'private, no-store'
    return response
