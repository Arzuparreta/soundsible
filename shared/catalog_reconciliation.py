"""Join catalog recordings to owned audio without guessing an album from a title.

Only portable recording IDs or a high-confidence cached YouTube resolution
certify a match. Browsing is read-only; an authenticated write fills an orphan's
release record in one canonical commit, keeping its audio and personal references.
"""
from dataclasses import replace
import re

from shared.library_lifecycle import LibraryPersistenceError, serialized
from shared.resolution_confidence import classify_confidence, rerank_cached_resolution
from shared.text_utils import identity_key


def _isrc(value):
    return re.sub(r"[\s-]", "", str(value or "")).upper()


def recording_match(item, tracks, db):
    """One unambiguous owned recording, independent of its release tags.

    Read the resolution cache without updating it: GET must remain read-only.
    Text and real durations must corroborate even a cached video association;
    conflicting portable IDs, different versions and duplicate files abstain.
    """
    artist, title = item.get('artist') or '', item.get('title') or ''
    external = item.get('external_ids') or {}
    cached = db.get_cached_resolution(artist, title) if db is not None else None
    if cached:
        cached = {**cached, **(rerank_cached_resolution(artist, title, item.get('duration'), cached) or {})}
    video = cached.get('id') if cached and classify_confidence(cached.get('confidence') or 0) == 'high' else None
    matches = []
    for track in tracks:
        if getattr(track, 'media_kind', None) == 'podcast_episode':
            continue
        if identity_key(track.title, track.artist) != identity_key(title, artist):
            continue
        if not track.duration or not item.get('duration') or abs(track.duration - item['duration']) > 10:
            continue
        isrc, mbid = _isrc(external.get('isrc')), external.get('musicbrainz_id')
        if (isrc and track.isrc and isrc != _isrc(track.isrc)) or (
            mbid and track.musicbrainz_id and mbid != track.musicbrainz_id
        ):
            continue
        if ((isrc and isrc == _isrc(track.isrc)) or (mbid and mbid == track.musicbrainz_id)
                or (video and video == track.youtube_id)):
            matches.append(track)
    return matches[0] if len(matches) == 1 else None


def orphan_release_changes(track, item):
    """An orphan takes the verified release whole, replacing upload defaults.

    A populated album or any manual metadata edit is authoritative. In
    particular, never move a recording from its single to an album implicitly.
    """
    raw = item.get('raw') or {}
    album = str(item.get('album') or '').strip()
    position = raw.get('track_number')
    if track.album.strip() or track.metadata_modified_by_user or not album or not position:
        return {}
    changes = {'album': album, 'album_artist': raw.get('album_artist'),
               'track_number': position, 'disc_number': raw.get('disc_number'),
               'year': raw.get('year'), 'disc_total': None, 'is_compilation': False}
    # This is a recording association certified above, not a name-only lookup.
    isrc = _isrc((item.get('external_ids') or {}).get('isrc'))
    if isrc and not track.isrc:
        changes['isrc'] = isrc
    return changes


def annotate_owned_recordings(profile, tracks, db):
    """Fresh account holdings over public album data, never cached with it."""
    result = {**profile, 'tracklist': [], 'reconciliation_needed': False}
    repairs = {}
    for original in profile.get('tracklist') or []:
        item = {**original, 'action_state': dict(original.get('action_state') or {})}
        track = recording_match(item, tracks, db)
        if track:
            item['track_id'] = track.id
            item['action_state'].update(in_library=True, playable=True, downloadable=False, needs_resolution=False)
            _add_repair(repairs, track, item)
        result['tracklist'].append(item)
    result['in_library'] = bool(profile.get('in_library')) or any(
        item['action_state'].get('in_library') for item in result['tracklist'])
    result['reconciliation_needed'] = any(repairs.values())
    return result


def _add_repair(updates, track, item):
    changes = orphan_release_changes(track, item)
    if not changes:
        return
    # Two positions for the same audio are ambiguous, not last wins.
    if track.id in updates and updates[track.id] != changes:
        updates[track.id] = None
    elif track.id not in updates:
        updates[track.id] = changes


@serialized
def reconcile_album(lib, items, db):
    """Recheck under the library lifecycle lock and persist all repairs once."""
    lib.refresh_if_stale()
    with lib._lock:
        if not lib.metadata:
            return []
        updates = {}
        for item in items:
            track = recording_match(item, lib.metadata.tracks, db)
            if track:
                _add_repair(updates, track, item)
        updates = {key: changes for key, changes in updates.items() if changes}
        if not updates:
            return []
        lib.metadata = replace(lib.metadata, tracks=[
            replace(track, **updates[track.id]) if track.id in updates else track for track in lib.metadata.tracks
        ])
    # _save_metadata takes the non-reentrant model lock itself. The outer
    # lifecycle lock still excludes every canonical writer between these steps.
    if not lib._save_metadata():
        raise LibraryPersistenceError(lib.last_save_error)
    return list(updates)
