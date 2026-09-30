"""Downloading a whole catalog collection through the import runner.

An album download is an import whose source is the catalog instead of an
export: durable, one song at a time, skipping what the library already holds,
and holding doubtful matches for the listener to decide. It reuses that
machinery rather than growing a second one.

A collection's job is named ``<kind>:<catalog id>`` in the ``provider`` column,
which is how it is found again and how the import screen leaves it out: an
export's provider never contains a colon.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

from shared.migration.match import LibraryMatcher
from shared.migration.models import MigrationManifest, SourceTrack
from shared.migration.store import MigrationStore

#: A job still doing, or waiting on the listener for, something. Asking for the
#: collection again hands it back as it is.
OPEN_STATES = frozenset({"analyzed", "queued", "running", "needs_review"})
#: A job that stopped short. Asking again picks it up where it stopped: the
#: versions the listener chose stand, and failed songs are tried again.
RESUMABLE_STATES = frozenset({"paused", "partial", "failed"})

_DEEZER_ID = re.compile(r"^\d{1,20}$")


def valid_deezer_id(value: object) -> str | None:
    text = str(value or "").strip()
    return text if _DEEZER_ID.match(text) else None


def album_provider(deezer_id: str) -> str:
    return f"album:{deezer_id}"


def is_collection_provider(provider: str) -> bool:
    return ":" in provider


def _text(value: object) -> str | None:
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return None


def catalog_identity_keys(item: dict[str, Any]) -> tuple[str, ...]:
    """The keys the player gives this catalog row (`catalogItemKeys` in
    `ui_web/src/lib/playbackIdentity.ts`). A download carrying them joins the
    song saved from the row, so the row can tell the song is here."""
    keys: list[str] = []

    def push(prefix: str, value: object) -> None:
        text = _text(value)
        if text:
            keys.append(f"{prefix}:{text}")

    external = item.get("external_ids") if isinstance(item.get("external_ids"), dict) else {}
    push("cat", item.get("id"))
    push("lib", item.get("track_id"))
    push("yt", external.get("youtube_id"))
    isrc = _text(external.get("isrc"))
    push("isrc", re.sub(r"[\s-]", "", isrc).upper() if isrc else None)
    push("mb", external.get("musicbrainz_id"))
    push("deezer", external.get("deezer_id"))
    return tuple(dict.fromkeys(keys))


def album_manifest(deezer_id: str, profile: dict[str, Any]) -> MigrationManifest:
    """One album, as the manifest of an import that holds every song on it."""
    provider = album_provider(deezer_id)
    title = str(profile.get("title") or "")
    album_artist = str(profile.get("artist") or "")
    year = profile.get("year") or 0
    manifest = MigrationManifest(provider=provider, source_name=title or "Album")
    for item in profile.get("tracklist") or []:
        if not isinstance(item, dict) or not item.get("title"):
            continue
        raw = item.get("raw") if isinstance(item.get("raw"), dict) else {}
        external = item.get("external_ids") if isinstance(item.get("external_ids"), dict) else {}
        track_id = _text(raw.get("deezer_id")) or _text(external.get("deezer_id")) or ""
        source = SourceTrack(
            title=str(item["title"]),
            artist=str(item.get("artist") or album_artist),
            album=title,
            source_id=f"deezer:{track_id}" if track_id else "",
            duration=int(item.get("duration") or 0),
            album_artist=album_artist,
            track_number=raw.get("track_number") or 0,
            disc_number=raw.get("disc_number") or 0,
            year=year if isinstance(year, int) else 0,
            identity_keys=catalog_identity_keys(item),
        )
        key = source.key(provider)
        if key in manifest.tracks:
            continue
        manifest.tracks[key] = source
        manifest.library_keys.append(key)
    return manifest


def start_collection_download(
    manifest: MigrationManifest,
    library_tracks: Iterable[Any],
    user_id: str,
    *,
    store: MigrationStore | None = None,
) -> dict[str, Any]:
    """Download every song in a collection the library does not hold yet.

    An open job for the same collection is handed back as it is, and one that
    stopped short is resumed. A finished one gives way to a fresh pass, which
    matches the library again: the songs the last pass brought are skipped, and
    one deleted since is fetched anew.
    """
    from shared.migration.service import start_migration_job

    if not manifest.tracks:
        raise ValueError("The collection has no songs")
    store = store or MigrationStore()
    latest = store.latest_job(manifest.provider)
    if latest is not None:
        if latest["state"] in OPEN_STATES:
            return latest
        if latest["state"] in RESUMABLE_STATES:
            store.reset_retryable(latest["id"])
            start_migration_job(latest["id"], user_id)
            return store.get_job(latest["id"])
        store.set_job_state(latest["id"], "cancelled")

    matcher = LibraryMatcher(list(library_tracks))
    matches = []
    for index, (source_key, source) in enumerate(manifest.tracks.items()):
        result = matcher.match(source, index)
        # A song the library holds for certain is skipped. A merely similar one
        # is no reason to stop the download and ask: it is fetched like the rest.
        held = result.matched_track_id if result.auto_accept else None
        matches.append({
            "source_key": source_key,
            "matched_track_id": held,
            "confidence": result.confidence if held else 0.0,
            "auto_accept": bool(held),
        })
    job, _ = store.create_job(manifest, matches)
    store.configure(job["id"], include_library=True, playlist_ids=[], playlist_names={})
    start_migration_job(job["id"], user_id)
    return store.get_job(job["id"])


def collection_job(provider: str, *, store: MigrationStore | None = None) -> dict[str, Any] | None:
    """The latest download of a collection, with its songs, or None."""
    store = store or MigrationStore()
    latest = store.latest_job(provider, include_tracks=True)
    if latest is None or latest["state"] == "cancelled":
        return None
    return latest
