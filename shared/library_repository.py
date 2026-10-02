"""Canonical library transactions and revision-based synchronization.

DatabaseManager supplies the connection and track/catalog adapters. This
repository owns the library boundary; API handlers never mutate a live snapshot.
"""
from __future__ import annotations

import json
import hashlib
import sqlite3
import uuid
from typing import Any, Dict, List, Optional

from shared.models import LibraryMetadata


class LibraryConflict(RuntimeError):
    """The caller's snapshot is no longer current."""


class LibraryRepository:
    def replace_library(
        self,
        metadata: LibraryMetadata,
        *,
        id_replacements: Optional[Dict[str, str]] = None,
        expected_revision: Optional[int] = None,
        changed_ids: Optional[set[str]] = None,
    ) -> int:
        """Atomically replace the canonical library and return its revision."""
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                if expected_revision is not None and self._revision(conn) != expected_revision:
                    raise LibraryConflict("Library changed before the write; refresh and retry")
                aliases = self._track_id_aliases(conn, id_replacements)
                # This is the persistence boundary for a complete library
                # snapshot.  Normalize here as a final invariant even when a
                # caller forgot to update one of the reference-bearing fields.
                metadata.remap_track_ids(aliases)
                conn.executemany(
                    """
                    INSERT INTO track_id_aliases (old_track_id, new_track_id)
                    VALUES (?, ?)
                    ON CONFLICT(old_track_id) DO UPDATE SET
                        new_track_id=excluded.new_track_id
                    """,
                    aliases.items(),
                )
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
                # Note: Update version
                conn.execute("INSERT OR REPLACE INTO library_info (key, value) VALUES ('version', ?)", (str(metadata.version),))
                
                incoming_ids = {track.id for track in metadata.tracks}
                if changed_ids is None:
                    # Avoid SQLite's platform-dependent SQL-variable ceiling.
                    conn.execute("CREATE TEMP TABLE IF NOT EXISTS incoming_tracks(id TEXT PRIMARY KEY)")
                    conn.execute("DELETE FROM incoming_tracks")
                    conn.executemany("INSERT INTO incoming_tracks VALUES (?)", ((identifier,) for identifier in incoming_ids))
                    deleted = conn.execute("SELECT DISTINCT album_id FROM tracks WHERE id NOT IN (SELECT id FROM incoming_tracks)").fetchall()
                    conn.execute("DELETE FROM tracks WHERE id NOT IN (SELECT id FROM incoming_tracks)")
                    stored = {row[0]: row[1] for row in conn.execute("SELECT track_id, fingerprint FROM track_fingerprints")}
                    candidates = metadata.tracks
                else:
                    # Targeted edits and rekeys never inventory unrelated rows.
                    deleted = []
                    for identifier in changed_ids - incoming_ids:
                        deleted.extend(conn.execute("SELECT album_id FROM tracks WHERE id=?", (identifier,)).fetchall())
                        conn.execute("DELETE FROM tracks WHERE id=?", (identifier,))
                    stored = {}
                    for identifier in changed_ids:
                        row = conn.execute("SELECT fingerprint FROM track_fingerprints WHERE track_id=?", (identifier,)).fetchone()
                        if row:
                            stored[identifier] = row[0]
                    candidates = [track for track in metadata.tracks if track.id in changed_ids]
                # Removed album members may have supplied its year/genre. The
                # surviving members must re-project that album as well.
                affected_members = []
                for album in {row[0] for row in deleted if row[0]}:
                    rows = conn.execute("SELECT * FROM tracks WHERE album_id=?", (album,)).fetchall()
                    affected_members.extend(self._flat_track_from_row(row) for row in rows)

                changed_tracks = []
                for track in candidates:
                    fingerprint = hashlib.sha256(json.dumps(track.to_dict(), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
                    if stored.get(track.id) == fingerprint:
                        continue
                    changed_tracks.append(track)
                    # Note: Column order MUST match the tuple below exactly
                    conn.execute("""
                        INSERT INTO tracks (
                            id, title, artist, album, duration, file_hash, 
                            original_filename, compressed, file_size, bitrate, 
                            format, cover_art_key, year, genre, track_number, 
                            disc_number, disc_total, is_compilation, media_kind,
                            podcast_feed_id, podcast_episode_guid, podcast_rss_url, artists_json,
                            is_local, local_path, local_mtime_ns, musicbrainz_id, isrc, album_artist,
                            cover_source, metadata_modified_by_user, youtube_id,
                            audio_quality, audio_source, audio_source_url,
                            audio_license_url, audio_identity_verified, added_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET
                            title=excluded.title,
                            artist=excluded.artist,
                            album=excluded.album,
                            duration=excluded.duration,
                            file_hash=excluded.file_hash,
                            original_filename=excluded.original_filename,
                            compressed=excluded.compressed,
                            file_size=excluded.file_size,
                            bitrate=excluded.bitrate,
                            format=excluded.format,
                            cover_art_key=excluded.cover_art_key,
                            year=excluded.year,
                            genre=excluded.genre,
                            track_number=excluded.track_number,
                            disc_number=excluded.disc_number,
                            disc_total=excluded.disc_total,
                            is_compilation=excluded.is_compilation,
                            media_kind=excluded.media_kind,
                            podcast_feed_id=excluded.podcast_feed_id,
                            podcast_episode_guid=excluded.podcast_episode_guid,
                            podcast_rss_url=excluded.podcast_rss_url,
                            artists_json=excluded.artists_json,
                            is_local=excluded.is_local,
                            local_path=excluded.local_path,
                            local_mtime_ns=excluded.local_mtime_ns,
                            musicbrainz_id=excluded.musicbrainz_id,
                            isrc=excluded.isrc,
                            album_artist=excluded.album_artist,
                            cover_source=excluded.cover_source,
                            metadata_modified_by_user=excluded.metadata_modified_by_user,
                            youtube_id=excluded.youtube_id,
                            audio_quality=excluded.audio_quality,
                            audio_source=excluded.audio_source,
                            audio_source_url=excluded.audio_source_url,
                            audio_license_url=excluded.audio_license_url,
                            audio_identity_verified=excluded.audio_identity_verified,
                            -- First seen wins. A manifest that has forgotten the
                            -- date (an older export, a remote copy) must never be
                            -- able to redate a song the library already holds.
                            added_at=COALESCE(tracks.added_at, excluded.added_at)
                    """, (
                        track.id, track.title, track.artist, track.album,
                        track.duration, track.file_hash, track.original_filename, 
                        track.compressed, track.file_size, track.bitrate, track.format, 
                        track.cover_art_key, track.year, track.genre, track.track_number, 
                        track.disc_number, track.disc_total, track.is_compilation, track.media_kind,
                        track.podcast_feed_id, track.podcast_episode_guid, track.podcast_rss_url,
                        json.dumps(track.artists, ensure_ascii=False) if track.artists is not None else None,
                        track.is_local, track.local_path, track.local_mtime_ns,
                        track.musicbrainz_id, track.isrc, track.album_artist,
                        track.cover_source, track.metadata_modified_by_user, track.youtube_id,
                        track.audio_quality, track.audio_source, track.audio_source_url,
                        track.audio_license_url, track.audio_identity_verified,
                        # A replaced id keeps the date of the row it replaced.
                        # NULL is left as NULL rather than defaulted to now:
                        # undated rows are what `backfill_added_at` recognises,
                        # and stamping them here would date a library that has
                        # been around for months with the moment of one save.
                        replacement_added_at.get(track.id) or track.added_at,
                    ))


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
                # Keep unchanged positions untouched; changes feed consumers
                # need only moved entries, not the entire library on every add.
                if changed_ids is None:
                    previous_order = {row[0]: row[1] for row in conn.execute("SELECT track_id, position FROM library_tracks")}
                else:
                    previous_order = {}
                    for identifier in changed_ids:
                        row = conn.execute("SELECT position FROM library_tracks WHERE track_id=?", (identifier,)).fetchone()
                        if row:
                            previous_order[identifier] = row[0]
                for position, track in enumerate(metadata.tracks):
                    if changed_ids is not None and track.id not in changed_ids:
                        continue
                    if previous_order.get(track.id) != position:
                        conn.execute("INSERT INTO library_tracks(track_id, position) VALUES (?, ?) ON CONFLICT(track_id) DO UPDATE SET position=excluded.position", (track.id, position))
                projected = {track.id: track for track in affected_members}
                projected.update({track.id: track for track in changed_tracks})
                self._replace_catalog_projection(conn, projected.values(), incremental=True)
                for track in changed_tracks:
                    fingerprint = hashlib.sha256(json.dumps(track.to_dict(), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
                    conn.execute("INSERT OR REPLACE INTO track_fingerprints VALUES (?, ?)", (track.id, fingerprint))

                self._write_playlists(conn, metadata.playlists)

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
                    int(metadata.version),
                    metadata.last_updated,
                    json.dumps(metadata.settings, ensure_ascii=False),
                    json.dumps(metadata.podcast_subscriptions, ensure_ascii=False),
                    json.dumps(metadata.podcast_episode_cache, ensure_ascii=False),
                ))
                self._prune_changes(conn)
                conn.execute("COMMIT")
                return revision
            except Exception as e:
                conn.execute("ROLLBACK")
                raise e

    def sync_from_metadata(self, metadata: LibraryMetadata):
        """Compatibility name for callers migrating a complete manifest."""
        return self.replace_library(metadata)

    def has_canonical_library(self) -> bool:
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT canonical FROM library_state WHERE singleton = 1"
            ).fetchone()
            return bool(row and row[0])

    @staticmethod
    def _revision(conn):
        row = conn.execute("SELECT revision FROM library_state WHERE singleton=1 AND canonical=1").fetchone()
        return int(row[0]) if row else 0

    def get_library_revision(self) -> int:
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT revision FROM library_state WHERE singleton = 1 AND canonical = 1"
            ).fetchone()
            return int(row[0]) if row else 0

    def load_library_metadata(self) -> Optional[LibraryMetadata]:
        """Load the complete canonical snapshot, preserving playlist order."""
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            state = conn.execute(
                "SELECT * FROM library_state WHERE singleton = 1 AND canonical = 1"
            ).fetchone()
            if state is None:
                return None
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
            # Normally rows are already canonical.  This also repairs a stale
            # write from an old client in memory before it reaches the API, and
            # the next save makes that normalization durable.
            metadata.remap_track_ids(self._track_id_aliases(conn))
            return metadata

    @staticmethod
    def _create_sync_schema(conn):
        conn.execute("CREATE TABLE IF NOT EXISTS track_fingerprints (track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL)")
        conn.execute("CREATE TABLE IF NOT EXISTS library_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, track_id TEXT)")
        conn.execute("CREATE INDEX IF NOT EXISTS library_changes_track ON library_changes(track_id, seq)")
        conn.execute("CREATE TABLE IF NOT EXISTS library_sync (singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch TEXT NOT NULL, floor INTEGER NOT NULL DEFAULT 0)")
        conn.execute("INSERT OR IGNORE INTO library_sync(singleton, epoch) VALUES (1, ?)", (uuid.uuid4().hex,))
        for table, key in (("tracks", "id"), ("library_tracks", "track_id"), ("library_state", None)):
            for event, reference in (("INSERT", "NEW"), ("UPDATE", "NEW"), ("DELETE", "OLD")):
                value = f"{reference}.{key}" if key else "NULL"
                conn.execute(f"CREATE TRIGGER IF NOT EXISTS sync_{table}_{event.lower()} AFTER {event} ON {table} BEGIN INSERT INTO library_changes(track_id) VALUES ({value}); END")
        # Direct SQL writers invalidate the comparison cache too. Keeping a
        # stale fingerprint would let a later snapshot silently skip that row.
        conn.execute("CREATE TRIGGER IF NOT EXISTS invalidate_track_fingerprint AFTER UPDATE ON tracks BEGIN DELETE FROM track_fingerprints WHERE track_id=NEW.id; END")
        conn.execute("CREATE INDEX IF NOT EXISTS library_tracks_position ON library_tracks(position)")
        # Database files upgraded from a previous release need a first snapshot.
        if conn.execute("SELECT 1 FROM library_changes LIMIT 1").fetchone() is None:
            conn.execute("INSERT INTO library_changes(track_id) VALUES (NULL)")

    @staticmethod
    def _prune_changes(conn):
        # Retention is bounded; a client older than the floor gets a snapshot.
        latest = conn.execute("SELECT COALESCE(MAX(seq), 0) FROM library_changes").fetchone()[0]
        floor = max(0, latest - 20000)
        conn.execute("UPDATE library_sync SET floor = ? WHERE singleton = 1", (floor,))
        conn.execute("DELETE FROM library_changes WHERE seq <= ?", (floor,))

    @staticmethod
    def _write_playlists(conn, playlists):
        playlists = playlists if isinstance(playlists, dict) else {}
        old = {}
        for row in conn.execute("SELECT p.name, p.position, pt.track_id FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_name=p.name ORDER BY p.position, pt.position"):
            old.setdefault(row[0], (row[1], []))
            if row[2] is not None:
                old[row[0]][1].append(row[2])
        for name in old.keys() - playlists.keys():
            conn.execute("DELETE FROM playlists WHERE name = ?", (name,))
        for position, (name, ids) in enumerate(playlists.items()):
            previous = old.get(name)
            if previous is None or previous[0] != position:
                conn.execute("INSERT INTO playlists(name, position) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET position=excluded.position", (name, position))
            if previous is None or previous[1] != ids:
                conn.execute("DELETE FROM playlist_tracks WHERE playlist_name = ?", (name,))
                conn.executemany("INSERT INTO playlist_tracks VALUES (?, ?, ?)", ((name, index, track_id) for index, track_id in enumerate(ids)))

    def library_header(self, conn=None):
        """Read only state and playlists, independent of the number of songs."""
        conn = conn if conn is not None else self._get_connection()
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM library_state WHERE singleton=1 AND canonical=1").fetchone()
        if row is None:
            return None
        playlists = {}
        for entry in conn.execute("SELECT p.name, pt.track_id FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_name=p.name ORDER BY p.position, pt.position"):
            playlists.setdefault(entry[0], [])
            if entry[1] is not None:
                playlists[entry[0]].append(entry[1])
        return LibraryMetadata(version=row["version"], tracks=[], playlists=playlists,
            settings=json.loads(row["settings_json"]), last_updated=row["last_updated"],
            podcast_subscriptions=json.loads(row["podcast_subscriptions_json"]),
            podcast_episode_cache=json.loads(row["podcast_episode_cache_json"]))

    def mutate_playlists(self, operation):
        """Validate and commit against the latest state under one write lock.

        The callback sees a detached header, never the live LibraryManager.
        Exceptions roll back every field and do not publish events.
        """
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                metadata = self.library_header(conn)
                if metadata is None:
                    raise LibraryConflict("Library is not initialized")
                operation(metadata)
                metadata.remap_track_ids(self._track_id_aliases(conn))
                self._write_playlists(conn, metadata.playlists)
                conn.execute("UPDATE library_state SET revision=revision+1, last_updated=?, settings_json=? WHERE singleton=1", (metadata.last_updated, json.dumps(metadata.settings, ensure_ascii=False)))
                self._prune_changes(conn)
                revision = self._revision(conn)
                conn.execute("COMMIT")
                return metadata, revision
            except Exception:
                conn.execute("ROLLBACK")
                raise

    def library_page(self, *, since=None, epoch=None, cursor=0, revision=None, limit=250):
        """A bounded snapshot or delta page with a consistent revision fence.

        A writer between pages causes a conflict. Clients retry from their last
        committed revision; they never splice two snapshots into one library.
        Delta tombstones retain removed identities, including track rekeys.
        """
        limit = min(max(int(limit), 1), 500)
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("BEGIN")
            try:
                sync = conn.execute("SELECT epoch, floor FROM library_sync WHERE singleton=1").fetchone()
                latest = int(conn.execute("SELECT MAX(seq) FROM library_changes").fetchone()[0] or 0)
                if revision is not None and int(revision) != latest:
                    raise LibraryConflict("Library changed during pagination")
                full = since is None or epoch != sync[0] or int(since) < sync[1] or int(since) > latest
                if full:
                    rows = conn.execute("SELECT t.*, lt.position AS sync_position FROM library_tracks lt JOIN tracks t ON t.id=lt.track_id WHERE lt.position >= ? ORDER BY lt.position LIMIT ?", (cursor, limit+1)).fetchall()
                    selected = rows[:limit]
                    removed = []
                    next_cursor = int(selected[-1]["sync_position"])+1 if len(rows) > limit else None
                else:
                    rows = conn.execute("SELECT track_id, MAX(seq) AS seq FROM library_changes WHERE seq > ? AND seq <= ? AND track_id IS NOT NULL GROUP BY track_id HAVING MAX(seq) > ? ORDER BY seq LIMIT ?", (since, latest, cursor, limit+1)).fetchall()
                    selected = []
                    removed = []
                    for change in rows[:limit]:
                        track = conn.execute("SELECT t.*, lt.position AS sync_position FROM tracks t JOIN library_tracks lt ON lt.track_id=t.id WHERE t.id=?", (change[0],)).fetchone()
                        if track is None:
                            removed.append(change[0])
                        else:
                            selected.append(track)
                    next_cursor = rows[limit-1][1] if len(rows) > limit else None
                tracks = self._rows_to_tracks(conn, selected)
                positions = {row["id"]: row["sync_position"] for row in selected}
                payload = json.loads(self.library_header(conn).to_json()) if cursor == 0 else {}
                # API dictionaries have no machine-local paths.
                payload.update(tracks=[{k:v for k,v in track.to_dict().items() if k not in {"local_path", "local_mtime_ns"}} for track in tracks],
                    positions=positions, removed=removed, epoch=sync[0], revision=latest,
                    mode="snapshot" if full else "delta", next_cursor=next_cursor)
                conn.execute("COMMIT")
                return payload
            except Exception:
                conn.execute("ROLLBACK")
                raise
