"""Journal-driven library deltas; only bounded proofs are retained on disk.

A delta is a transition between two committed public sources. It sends rows
copied from the live model only after checking each one, and the headers,
against the hashes committed with that source, so it never walks the rest of
the library. Unsaved in-memory edits are never labelled with a committed
revision: a copied row or header that differs from its committed hash sends
the full response instead.
"""
from hashlib import sha256
import json
import time

from flask import current_app
from flask.json.provider import DefaultJSONProvider

from shared.api import library_deltas as history
from shared.library_fingerprint import TRACK_FIELDS, fingerprint, header_digest, public_row_digest, record, recorded
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


def header_digests(headers):
    """Digest each rendered field for comparison with a client's saved base."""
    return {key: history.digest(value).hex() for key, value in headers.items()}


def remember(account, revision, state, digests):
    if len(account.encode()) > 256:
        return
    proof = json.dumps({**state, 'headers': digests})
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


def committed_source(lib):
    """The account's committed public source, or None when it is not verified."""
    db = getattr(lib, 'db', None)
    return db.public_source() if isinstance(db, DatabaseManager) else None


def live_fingerprint(metadata, committed):
    """Return the fingerprint and whether it reused the committed hint.

    A read can establish a committed match after a reload. Observing unsaved
    changes must not replace the hint that another reader uses for a delta.
    """
    if committed is not None and recorded(metadata) == committed:
        return committed, True
    value = fingerprint(metadata)
    if value == committed:
        record(metadata, value)
    return value, False


def prepare(lib, artwork, dependencies, model_fingerprint=None):
    """Tie the committed public source to the current annotation cursors.

    With `model_fingerprint`, only when the caller's detached model is exactly
    that source, which lets a full response carry the committed revision.
    """
    if not supported(lib) or dependencies is None:
        return None
    source = lib.db.public_source()
    if source is None or (model_fingerprint is not None and source['fingerprint'] != model_fingerprint):
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


def try_delta(lib, artwork, account, base_revision, dependencies, model_fingerprint=None):
    if not supported(lib) or not base_revision or len(base_revision) > 128:
        return None
    base = load_base(account, base_revision)
    if base is None:
        return None
    state = prepare(lib, artwork, dependencies)
    if state is None:
        return None
    committed = state['source']['fingerprint']
    header_hash = state['source']['headers']
    if header_hash is None and committed != base['source']['fingerprint']:
        return None
    if model_fingerprint is None:
        model_fingerprint, _ = live_fingerprint(lib.metadata, committed)
    if model_fingerprint != committed:
        return None
    artwork_ids = artwork.changed_tracks(base['art'], state['art'])
    identities = LoudnessStore().changed_identities(base['loud'], state['loud'])
    if artwork_ids is None or identities is None:
        return None
    affected = lib.db.public_changes(base['source'], state['source'], artwork_ids, identities)
    if affected is None:
        return None
    positions, removed, order = affected
    tracks = lib.metadata.tracks
    copied = {}
    for track_id, (position, row_hash) in positions.items():
        track = tracks[position] if position < len(tracks) else None
        if type(track) is not Track or track.id != track_id:
            return None
        row = track.to_public_dict()
        # The exact detached row we will send, so an edit made while copying,
        # or one not yet saved, cannot travel under the committed revision.
        if public_row_digest(row) != row_hash:
            return None
        copied[position] = row
    headers = lib.metadata.public_headers()
    if header_hash is not None and header_digest(headers) != header_hash:
        return None
    digests = header_digests(headers)
    fields = {name: headers[name] for name, digest in digests.items() if digest != base['headers'].get(name)}
    # Older engines did not save a header hash. A served base for the same
    # canonical fingerprint already proves the exact headers the client has.
    if header_hash is None and fields:
        return None
    upserts = [copied[position] for position in sorted(copied)]
    if not annotate_tracks(upserts, selected=True):
        return None
    artwork.annotate(upserts)
    delta = {'kind': 'delta', 'base_revision': base_revision, 'revision': revision_for(account, state),
             'upserts': upserts, 'removed': removed, 'fields': fields}
    if order is not None:
        delta['order'] = order
    if not still_current(lib, artwork, state):
        return None
    response = current_app.json.response(delta)
    if len(response.get_data()) >= len(lib.metadata.tracks) * MIN_TRACK_BYTES:
        return None
    remember(account, delta['revision'], state, digests)
    from shared.api.library_revision import validator_key, validators
    validators.put(validator_key(account, state['source']['fingerprint'], dependencies), delta['revision'])
    response.headers['Cache-Control'] = 'private, no-store'
    return response
