"""The canonical library: whole-library and per-track writes, revisions, and the catalog
projection they keep.

One part of `shared.database.DatabaseManager`; every method runs on the manager
and reaches SQLite through `self._get_connection()`.
"""

import sqlite3
import json
import logging
import os
import time
from contextlib import contextmanager, nullcontext
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional, Iterable
from shared.models import Track, LibraryMetadata
from shared.library_dates import parse as _parse_timestamp
from shared.library_lifecycle import serialized
from shared.library_write import disk_staging, staged_rows, sync_rows, sync_tracks
from shared.time_utils import UTC

from shared.db.catalog import MUSIC_ONLY

logger = logging.getLogger(__name__)


class StaleLibraryWrite(RuntimeError):
    """A whole-library write was refused because the canonical state moved on.

    ``replace_library`` replaces the complete logical library from one
    in-memory snapshot, persisting only differences. A writer holding a snapshot
    taken before somebody else's commit would not merely lose its own change: it
    would silently undo theirs. Callers that know which revision their snapshot
    came from say so, and get this instead of a quiet revert.
    """

    def __init__(self, expected: int, actual: int):
        super().__init__(
            f"canonical library moved from revision {expected} to {actual}; write refused"
        )
        self.expected = expected
        self.actual = actual


def _format_timestamp(moment: datetime) -> str:
    return moment.replace(tzinfo=None).isoformat()


class LibraryStore:

    @staticmethod
    def _flat_track_from_row(row: sqlite3.Row | tuple, columns: list[str] | None = None) -> Track:
        data = dict(row) if isinstance(row, sqlite3.Row) else dict(zip(columns or [], row))
        data.pop("last_updated", None)
        data.pop("album_id", None)
        stored_artists = data.pop("artists_json", None)
        data["is_local"] = bool(data.get("is_local"))
        data["metadata_modified_by_user"] = bool(data.get("metadata_modified_by_user"))
        data["is_compilation"] = bool(data.get("is_compilation"))
        data["artists"] = json.loads(stored_artists) if stored_artists else None
        return Track.from_dict(data)

    @staticmethod
    def _replace_catalog_projection(conn, tracks: Iterable[Track]) -> None:
        """Replace derived entities/links while preserving surviving user state."""
        from shared.library_catalog import build_catalog_snapshot

        track_list = list(tracks)
        snapshot = build_catalog_snapshot(track_list)

        conn.executemany(
            """
            INSERT INTO artists (id, name, name_key)
            VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                name_key=excluded.name_key,
                updated_at=CURRENT_TIMESTAMP
            WHERE artists.name IS NOT excluded.name OR artists.name_key IS NOT excluded.name_key
            """,
            ((artist.id, artist.name, artist.name_key) for artist in snapshot.artists),
        )
        conn.executemany(
            """
            INSERT INTO albums (
                id, title, title_key, album_artist_id, album_artist,
                year, genre, is_compilation
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                title=excluded.title,
                title_key=excluded.title_key,
                album_artist_id=excluded.album_artist_id,
                album_artist=excluded.album_artist,
                year=excluded.year,
                genre=excluded.genre,
                is_compilation=excluded.is_compilation,
                updated_at=CURRENT_TIMESTAMP
            WHERE albums.title IS NOT excluded.title
               OR albums.title_key IS NOT excluded.title_key
               OR albums.album_artist_id IS NOT excluded.album_artist_id
               OR albums.album_artist IS NOT excluded.album_artist
               OR albums.year IS NOT excluded.year
               OR albums.genre IS NOT excluded.genre
               OR albums.is_compilation IS NOT excluded.is_compilation
            """,
            (
                (
                    album.id,
                    album.title,
                    album.title_key,
                    album.album_artist_id,
                    album.album_artist,
                    album.year,
                    album.genre,
                    int(album.is_compilation),
                )
                for album in snapshot.albums
            ),
        )

        sync_rows(conn, 'track_artists', ('track_id', 'artist_id', 'position'), ('track_id', 'position'),
                  ((link.track_id, identifier, position) for link in snapshot.tracks
                   for position, identifier in enumerate(link.artist_ids)), delete_changed=True)
        conn.executemany(
            "UPDATE tracks SET album_id = ? WHERE id = ? AND album_id IS NOT ?",
            ((link.album_id, link.track_id, link.album_id) for link in snapshot.tracks),
        )
        # Also used during migrations; preserve pruning semantics without a
        # parameter per incoming song.
        with staged_rows(conn, 'library_tracks', ('track_id',), ('track_id',),
                         ((track.id,) for track in track_list)) as incoming:
            conn.execute(f'DELETE FROM track_user_state WHERE NOT EXISTS '
                         f'(SELECT 1 FROM {incoming} n WHERE n.track_id=track_user_state.track_id)')

        conn.execute("DELETE FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL)")
        conn.execute("""
            DELETE FROM artists
            WHERE id NOT IN (SELECT artist_id FROM track_artists)
              AND id NOT IN (SELECT album_artist_id FROM albums)
        """)

    @classmethod
    def _sync_catalog_projection(cls, conn) -> None:
        """Rebuild artists and albums once when the projection rules changed.

        Also when tracks have no catalog links at all: a flat pre-catalog
        database, or catalog tables recreated empty. Otherwise two small reads.
        Tracks are projected in manifest order, as a save would, because an
        album takes the first year and genre it meets.
        """
        from shared.library_catalog import PROJECTION_VERSION

        row = conn.execute(
            "SELECT value FROM library_info WHERE key = 'catalog_projection_version'"
        ).fetchone()
        # Podcast episodes never get links, so only songs count here.
        unlinked = conn.execute(
            f"SELECT EXISTS (SELECT 1 FROM tracks t WHERE {MUSIC_ONLY}) "
            "AND NOT EXISTS (SELECT 1 FROM track_artists)"
        ).fetchone()[0]
        if row is not None and row[0] == str(PROJECTION_VERSION) and not unlinked:
            return
        cursor = conn.execute(
            "SELECT t.* FROM tracks t LEFT JOIN library_tracks l ON l.track_id = t.id "
            "ORDER BY l.position IS NULL, l.position, t.rowid"
        )
        columns = [description[0] for description in cursor.description]
        cls._replace_catalog_projection(
            conn, (cls._flat_track_from_row(track, columns) for track in cursor)
        )
        conn.execute(
            "INSERT INTO library_info (key, value) VALUES ('catalog_projection_version', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(PROJECTION_VERSION),),
        )

    @serialized
    def replace_library(
        self,
        metadata: LibraryMetadata,
        *,
        id_replacements: Optional[Dict[str, str]] = None,
        expected_revision: Optional[int] = None,
        operation_id: Optional[str] = None,
        playlist_entry=None,
    ) -> int:
        """Atomically replace the canonical library and return its revision.

        ``expected_revision`` is the revision the caller's snapshot was built
        from. When it no longer matches, nothing is written and
        :class:`StaleLibraryWrite` is raised: this call replaces the whole
        library, so committing a snapshot that predates somebody else's write
        would erase it. Omit it only when the snapshot *is* the library (a
        migration, a repair that just reloaded it).
        """
        if expected_revision is not None:
            # Cheap pre-check so the common rejection costs no side effects;
            # the authoritative one happens inside the transaction below.
            current = self.get_library_revision()
            if current != expected_revision:
                raise StaleLibraryWrite(expected_revision, current)
        if id_replacements:
            from shared.artwork import artwork_store
            artwork_store().remap(id_replacements)
        with self._get_connection() as conn, disk_staging(conn):
            conn.execute("BEGIN IMMEDIATE")
            try:
                if operation_id and conn.execute("SELECT 1 FROM library_operations WHERE id=?", (operation_id,)).fetchone():
                    revision = conn.execute("SELECT revision FROM library_state WHERE singleton=1").fetchone()[0]
                    conn.execute("ROLLBACK")
                    return int(revision)
                if expected_revision is not None:
                    row = conn.execute(
                        "SELECT revision FROM library_state WHERE singleton = 1"
                    ).fetchone()
                    current = int(row[0]) if row else 0
                    if current != expected_revision:
                        raise StaleLibraryWrite(expected_revision, current)
                aliases = self._track_id_aliases(conn, id_replacements)
                # This is the persistence boundary for a complete library
                # snapshot.  Normalize here as a final invariant even when a
                # caller forgot to update one of the reference-bearing fields.
                conn.executemany(
                    """
                    INSERT INTO track_id_aliases (old_track_id, new_track_id)
                    VALUES (?, ?)
                    ON CONFLICT(old_track_id) DO UPDATE SET
                        new_track_id=excluded.new_track_id
                    WHERE track_id_aliases.new_track_id IS NOT excluded.new_track_id
                    """,
                    aliases.items(),
                )
                from shared.collection import sync as sync_collection, admit, entries, save_entries
                metadata.remap_track_ids(aliases, references=False)
                sync_collection(conn, metadata, self.db_path, id_replacements)
                if playlist_entry is not None:
                    name, entry = playlist_entry
                    if name not in metadata.playlists:
                        raise ValueError("Playlist not found")
                    from shared.collection_repair import require_description
                    require_description(conn, entry)
                    item_id = admit(conn, entry)
                    entry['item_id'] = item_id
                    saved = entries(conn)
                    if not any(row["item_id"] == item_id for row in saved):
                        saved.insert(0, {**entry, "item_id": item_id})
                        save_entries(conn, saved)
                    metadata.add_to_playlist(name, item_id)
                # One detached copy of the headers is both stored and proven,
                # whatever happens to the live model meanwhile.
                headers = metadata.public_headers()
                replacement_state: Dict[str, sqlite3.Row] = {}
                # The date the replaced row carried. A rescan or a lossless
                # upgrade gives one song a new id; without this it would read as
                # newly added, which is the one thing it is not.
                replacement_added_at: Dict[str, Any] = {}
                conn.row_factory = sqlite3.Row
                for old_id, new_id in (id_replacements or {}).items():
                    if old_id == new_id:
                        continue
                    row = conn.execute(
                        "SELECT * FROM track_user_state WHERE track_id = ?", (old_id,)
                    ).fetchone()
                    if row is not None:
                        replacement_state[new_id] = row
                    dated = conn.execute(
                        "SELECT added_at FROM tracks WHERE id = ?", (old_id,)
                    ).fetchone()
                    if dated is not None and dated["added_at"]:
                        replacement_added_at[new_id] = dated["added_at"]
                conn.execute("INSERT INTO library_info (key, value) VALUES ('version', ?) "
                             "ON CONFLICT(key) DO UPDATE SET value=excluded.value "
                             "WHERE library_info.value IS NOT excluded.value", (str(headers["version"]),))
                tracks = tuple(metadata.tracks)
                track_ids = tuple(track.id for track in tracks)
                # Stage only IDs/order, avoiding a full manifest-sized IN list.
                with staged_rows(conn, 'library_tracks', ('track_id', 'position'), ('track_id',),
                                 ((track_id, i) for i, track_id in enumerate(track_ids))) as incoming:
                    catalog_dirty = conn.execute(
                        f'SELECT 1 FROM {incoming} n LEFT JOIN library_tracks l ON l.track_id=n.track_id '
                        'WHERE l.position IS NOT n.position LIMIT 1').fetchone() is not None
                    removed = conn.execute(
                        f'DELETE FROM tracks WHERE NOT EXISTS (SELECT 1 FROM {incoming} n WHERE n.track_id=tracks.id)').rowcount
                    catalog_dirty |= bool(removed)
                order_changed = catalog_dirty
                catalog_changes, public_fingerprint = sync_tracks(conn, tracks, track_ids, replacement_added_at, headers)
                catalog_dirty |= catalog_changes

                for new_id, state in replacement_state.items():
                    conn.execute(
                        """
                        INSERT INTO track_user_state (
                            track_id, play_count, rating, last_played_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(track_id) DO UPDATE SET
                            play_count=MAX(track_user_state.play_count, excluded.play_count),
                            rating=COALESCE(excluded.rating, track_user_state.rating),
                            last_played_at=CASE
                                WHEN track_user_state.last_played_at IS NULL THEN excluded.last_played_at
                                WHEN excluded.last_played_at IS NULL THEN track_user_state.last_played_at
                                ELSE MAX(track_user_state.last_played_at, excluded.last_played_at)
                            END,
                            updated_at=MAX(track_user_state.updated_at, excluded.updated_at)
                        """,
                        (
                            new_id,
                            state["play_count"],
                            state["rating"],
                            state["last_played_at"],
                            state["updated_at"],
                        ),
                    )
                from shared.collection import project_user_state
                project_user_state(conn)
                if catalog_dirty:
                    self._replace_catalog_projection(conn, tracks)

                sync_rows(conn, 'library_tracks', ('track_id', 'position'), ('track_id',),
                          ((track_id, i) for i, track_id in enumerate(track_ids)))
                playlist_map = headers["playlists"] if isinstance(headers["playlists"], dict) else {}
                sync_rows(conn, 'playlists', ('name', 'position'), ('name',),
                          ((name, i) for i, name in enumerate(playlist_map)))
                sync_rows(conn, 'playlist_tracks', ('playlist_name', 'position', 'track_id'),
                          ('playlist_name', 'position'),
                          ((name, i, track_id) for name, ids in playlist_map.items() for i, track_id in enumerate(ids)))

                previous = conn.execute(
                    "SELECT revision FROM library_state WHERE singleton = 1"
                ).fetchone()
                revision = (int(previous[0]) if previous else 0) + 1
                conn.execute("""
                    INSERT INTO library_state (
                        singleton, canonical, revision, version, last_updated,
                        settings_json, podcast_subscriptions_json,
                        podcast_episode_cache_json
                    ) VALUES (1, 1, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(singleton) DO UPDATE SET
                        canonical=1,
                        revision=excluded.revision,
                        version=excluded.version,
                        last_updated=excluded.last_updated,
                        settings_json=excluded.settings_json,
                        podcast_subscriptions_json=excluded.podcast_subscriptions_json,
                        podcast_episode_cache_json=excluded.podcast_episode_cache_json
                """, (
                    revision,
                    int(headers["version"]),
                    headers["last_updated"],
                    json.dumps(headers["settings"], ensure_ascii=False),
                    json.dumps(headers["podcast_subscriptions"], ensure_ascii=False),
                    json.dumps(headers["podcast_episode_cache"], ensure_ascii=False),
                ))
                from shared.library_changes import sync_source
                sync_source(conn, metadata, order_changed, headers, public_fingerprint)
                from shared import library_search
                library_search.sync(conn)
                if operation_id:
                    conn.execute("INSERT INTO library_operations VALUES (?, ?)", (operation_id, int(time.time())))
                conn.execute("COMMIT")
                return revision
            except Exception as e:
                conn.execute("ROLLBACK")
                raise e

    @serialized
    def patch_track_metadata(self, track_id, changes, *, expected_revision, previous_fingerprint, metadata):
        """Commit an explicit edit without staging every track, list and header.

        The verified pre-edit fingerprint binds the caller's mutable model to
        this revision. The supplied post-edit model maintains existing public
        proofs/catalog/search contracts; fingerprints still take a full pass.
        """
        allowed = {'title', 'artist', 'album', 'album_artist', 'cover_source', 'metadata_modified_by_user'}
        if not changes or not set(changes) <= allowed:
            raise ValueError('Unsupported track metadata edit')
        from shared.library_changes import source, sync_track_source
        from shared import library_search
        with self._get_connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            try:
                current = conn.execute('SELECT revision FROM library_state WHERE singleton=1').fetchone()
                revision = int(current[0]) if current else 0
                if revision != expected_revision:
                    raise StaleLibraryWrite(expected_revision, revision)
                proof = source(conn)
                if proof is None or proof['fingerprint'] != previous_fingerprint:
                    raise ValueError('Track edit requires a verified canonical snapshot')
                fields = list(changes)
                row = conn.execute(f'SELECT {",".join(fields)} FROM tracks WHERE id=?', (track_id,)).fetchone()
                if row is None:
                    raise KeyError(track_id)
                position = conn.execute('SELECT position FROM library_tracks WHERE track_id=?', (track_id,)).fetchone()
                if position is None or metadata.tracks[position[0]].id != track_id:
                    raise ValueError('Track edit changed library membership')
                previous_values = {name: bool(row[i]) if name == 'metadata_modified_by_user' else row[i]
                                   for i, name in enumerate(fields)}
                assignments = ','.join(f'{field}=?' for field in fields)
                conn.execute(f'UPDATE tracks SET {assignments} WHERE id=?', [*(changes[field] for field in fields), track_id])
                catalog_changed = any(field in {'artist', 'album', 'album_artist'} and row[i] != changes[field]
                                      for i, field in enumerate(fields))
                if catalog_changed:
                    self._replace_catalog_projection(conn, metadata.tracks)
                conn.execute('UPDATE library_state SET revision=revision+1 WHERE singleton=1')
                sync_track_source(conn, metadata, position[0], changes, previous_values, previous_fingerprint)
                from shared.collection import update_file_snapshot
                update_file_snapshot(conn, metadata.tracks[position[0]])
                library_search.sync(conn)
                conn.execute('COMMIT')
                return revision + 1
            except BaseException:
                conn.execute('ROLLBACK')
                raise

    def has_library_operation(self, operation_id):
        with self._get_connection() as conn:
            return conn.execute("SELECT 1 FROM library_operations WHERE id=?", (operation_id,)).fetchone() is not None

    def sync_from_metadata(self, metadata: LibraryMetadata):
        """Compatibility name for callers migrating a complete manifest."""
        return self.replace_library(metadata)

    def has_canonical_library(self) -> bool:
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT canonical FROM library_state WHERE singleton = 1"
            ).fetchone()
            return bool(row and row[0])

    def public_source(self):
        from shared.library_changes import source
        with self._get_connection() as conn:
            conn.execute('BEGIN')
            try:
                return source(conn)
            finally:
                conn.rollback()

    @contextmanager
    def library_search_candidates(self, tracks, q_folded: str, q_tokens: frozenset):
        """Library-ordered rows covering every local search match, or None.

        None means the index cannot be proven to describe ``tracks`` (unsaved
        edits, an invalid or outdated index); callers then scan the model.
        The rows share one read snapshot and must be consumed inside the block.
        """
        from shared.library_search import candidates
        with self._get_connection() as conn:
            conn.execute('BEGIN')
            try:
                yield candidates(conn, tracks, q_folded, q_tokens)
            finally:
                conn.rollback()

    def public_changes(self, previous, expected, artwork_ids, identities):
        from shared.library_changes import affected
        with self._get_connection() as conn:
            conn.execute('BEGIN')
            try:
                return affected(conn, previous, expected, artwork_ids, identities)
            finally:
                conn.rollback()

    def get_library_revision(self) -> int:
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT revision FROM library_state WHERE singleton = 1 AND canonical = 1"
            ).fetchone()
            return int(row[0]) if row else 0

    def load_library_metadata(self) -> Optional[LibraryMetadata]:
        return self.load_library_snapshot()[0]

    def load_library_snapshot(self) -> tuple[Optional[LibraryMetadata], int]:
        """Read canonical metadata and its revision in the same SQLite snapshot."""
        from shared.collection import library_ready
        from shared.library_fingerprint import fingerprint, record
        from shared.library_lifecycle import coordinated
        with self._get_connection() as conn:
            upgrade = not library_ready(conn)
            with coordinated() if upgrade else nullcontext():
                conn.execute('BEGIN IMMEDIATE' if upgrade else 'BEGIN')
                metadata, revision = self._read_library_metadata(conn)
                conn.commit()
        if metadata is not None:
            try:
                record(metadata, fingerprint(metadata), loaded_revision=revision)
            except RecursionError:
                # Deeply nested legacy headers can exceed the encoder's limit.
                # Fingerprinting is optional for a canonical load.
                pass
        return metadata, revision

    def _read_library_metadata(self, conn) -> tuple[Optional[LibraryMetadata], int]:
        conn.row_factory = sqlite3.Row
        state = conn.execute(
            "SELECT * FROM library_state WHERE singleton = 1 AND canonical = 1"
        ).fetchone()
        if state is None:
            return None, 0
        revision = int(state["revision"])
        tracks = self._rows_to_tracks(conn, conn.execute("""
            SELECT t.* FROM tracks t
            JOIN library_tracks lt ON lt.track_id = t.id
            ORDER BY lt.position
        """).fetchall())
        playlist_rows = conn.execute("""
            SELECT p.name, pt.track_id
            FROM playlists p
            LEFT JOIN playlist_tracks pt ON pt.playlist_name = p.name
            ORDER BY p.position, pt.position
        """).fetchall()
        playlists: Dict[str, List[str]] = {}
        for row in playlist_rows:
            playlists.setdefault(str(row["name"]), [])
            if row["track_id"] is not None:
                playlists[str(row["name"])].append(str(row["track_id"]))
        metadata = LibraryMetadata(
            version=int(state["version"]),
            tracks=tracks,
            playlists=playlists,
            settings=json.loads(state["settings_json"]),
            last_updated=str(state["last_updated"]),
            podcast_subscriptions=json.loads(state["podcast_subscriptions_json"]),
            podcast_episode_cache=json.loads(state["podcast_episode_cache_json"]),
        )
        from shared.collection import library_ready, sync as sync_collection, attach_ids
        if not library_ready(conn):
            previous_playlists = json.dumps(metadata.playlists, sort_keys=True)
            previous_settings = json.dumps(metadata.settings, sort_keys=True)
            sync_collection(conn, metadata, self.db_path)
            conn.executemany('UPDATE playlist_tracks SET track_id=? WHERE playlist_name=? AND position=?',
                             ((value, name, position) for name, ids in metadata.playlists.items()
                              for position, value in enumerate(ids)))
            changed = previous_playlists != json.dumps(metadata.playlists, sort_keys=True) or previous_settings != json.dumps(metadata.settings, sort_keys=True)
            conn.execute('UPDATE library_state SET revision=revision+?,settings_json=? WHERE singleton=1',
                         (int(changed), json.dumps(metadata.settings)))
            revision += int(changed)
            conn.execute('UPDATE library_public_source SET valid=0')
            attach_ids(conn, metadata.tracks)
        # Normally rows are already canonical.  This also repairs a stale
        # write from an old client in memory before it reaches the API, and
        # the next save makes that normalization durable.
        metadata.remap_track_ids(self._track_id_aliases(conn), references=False)
        return metadata, revision

    def backfill_added_at(self, resolver: Optional[Any] = None) -> int:
        """Date the tracks a library from before `added_at` left behind.

        Two sources, in order of how much they know:

        * **The audio file's own mtime.** A downloaded track is written once,
          when it is acquired, so the file in the pool remembers the day the
          song arrived even though no row did. Measured against a real 197-track
          library, mtimes reproduced the manifest order with four inversions and
          spanned the four months the library was actually built over.
        * **The row before it.** A track whose file cannot be reached — remote
          storage, a deleted file, a manifest imported from elsewhere — inherits
          its predecessor's instant plus a millisecond, walking the library in
          its stored order. Nothing is invented: the ordering that results is
          exactly the manifest order the player has been showing all along.

        Idempotent, and cheap to call: with every row dated it costs one probe.
        Returns the number of rows filled in.
        """
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            if conn.execute("SELECT 1 FROM tracks WHERE added_at IS NULL LIMIT 1").fetchone() is None:
                return 0
            # Library order first, then anything the manifest no longer lists
            # (a pruned row still in `tracks`), so the walk below always follows
            # the order the player reads.
            rows = conn.execute("""
                SELECT t.*, lt.position AS library_position FROM tracks t
                LEFT JOIN library_tracks lt ON lt.track_id = t.id
                ORDER BY lt.position IS NULL, lt.position, t.rowid
            """).fetchall()

        if resolver is None:
            from shared.path_resolver import resolve_local_track_path as resolver

        def file_instant(row: sqlite3.Row) -> Optional[datetime]:
            try:
                path = resolver(self._row_to_track(row))
            except Exception:  # pragma: no cover — a resolver is never load-bearing
                return None
            if not path:
                return None
            try:
                return datetime.fromtimestamp(os.path.getmtime(path), UTC).replace(tzinfo=None)
            except OSError:
                return None

        filled: List[tuple] = []
        carried: Optional[datetime] = None
        undated: List[str] = []
        for row in rows:
            stored = row["added_at"]
            if stored:
                carried = _parse_timestamp(stored) or carried
                continue
            instant = file_instant(row)
            if instant is None:
                # Resolve it against whatever comes next: a run of unreachable
                # files at the head of the library has nothing behind it yet.
                undated.append(str(row["id"]))
                continue
            for index, track_id in enumerate(undated, start=1):
                # Kept strictly before `instant`, in their stored order, because
                # that order is the only thing known about them.
                filled.append((_format_timestamp(instant - timedelta(milliseconds=len(undated) - index + 1)), track_id))
            undated.clear()
            carried = instant
            filled.append((_format_timestamp(instant), str(row["id"])))
        for index, track_id in enumerate(undated, start=1):
            base = carried or datetime.now(UTC).replace(tzinfo=None)
            filled.append((_format_timestamp(base + timedelta(milliseconds=index)), track_id))

        if not filled:
            return 0
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.executemany(
                    "UPDATE tracks SET added_at = ? WHERE id = ? AND added_at IS NULL",
                    filled,
                )
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        logger.info("Database: dated %d track(s) that predate added_at", len(filled))
        return len(filled)

    def get_all_tracks(self) -> List[Track]:
        """Fetch all tracks as Track objects."""
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute("SELECT * FROM tracks ORDER BY artist, album, track_number")
            return self._rows_to_tracks(conn, cursor.fetchall())
