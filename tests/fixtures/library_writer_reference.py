"""Frozen canonical writer from 2ad6db3 for equivalence and cost comparisons."""
# ruff: noqa: F821
from __future__ import annotations

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

        conn.execute("DELETE FROM track_artists")
        conn.executemany(
            "INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, ?, ?)",
            (
                (link.track_id, identifier, position)
                for link in snapshot.tracks
                for position, identifier in enumerate(link.artist_ids)
            ),
        )
        conn.executemany(
            "UPDATE tracks SET album_id = ? WHERE id = ?",
            ((link.album_id, link.track_id) for link in snapshot.tracks),
        )

        incoming_ids = [track.id for track in track_list]
        if incoming_ids:
            placeholders = ",".join("?" for _ in incoming_ids)
            conn.execute(
                f"DELETE FROM track_user_state WHERE track_id NOT IN ({placeholders})",
                incoming_ids,
            )
        else:
            conn.execute("DELETE FROM track_user_state")

        conn.execute("DELETE FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL)")
        conn.execute("""
            DELETE FROM artists
            WHERE id NOT IN (SELECT artist_id FROM track_artists)
              AND id NOT IN (SELECT album_artist_id FROM albums)
        """)

def replace_library(
        self,
        metadata: LibraryMetadata,
        *,
        id_replacements: Optional[Dict[str, str]] = None,
        expected_revision: Optional[int] = None,
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
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
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
                
                # Note: 1. Get ids of tracks we are about to sync
                incoming_ids = [t.id for t in metadata.tracks]
                
                # Note: 2. Prune tracks that are no longer in the manifest
                if incoming_ids:
                    placeholders = ','.join(['?'] * len(incoming_ids))
                    conn.execute(f"DELETE FROM tracks WHERE id NOT IN ({placeholders})", incoming_ids)
                else:
                    conn.execute("DELETE FROM tracks")

                # Note: 3. Batch update tracks
                for track in metadata.tracks:
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
                self._replace_catalog_projection(conn, metadata.tracks)

                conn.execute("DELETE FROM library_tracks")
                conn.executemany(
                    "INSERT INTO library_tracks (track_id, position) VALUES (?, ?)",
                    ((track.id, position) for position, track in enumerate(metadata.tracks)),
                )

                conn.execute("DELETE FROM playlist_tracks")
                conn.execute("DELETE FROM playlists")
                playlist_map = metadata.playlists if isinstance(metadata.playlists, dict) else {}
                for playlist_position, (name, track_ids) in enumerate(playlist_map.items()):
                    conn.execute(
                        "INSERT INTO playlists (name, position) VALUES (?, ?)",
                        (name, playlist_position),
                    )
                    conn.executemany(
                        "INSERT INTO playlist_tracks (playlist_name, position, track_id) VALUES (?, ?, ?)",
                        ((name, position, track_id) for position, track_id in enumerate(track_ids)),
                    )

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
                conn.execute("COMMIT")
                return revision
            except Exception as e:
                conn.execute("ROLLBACK")
                raise e

