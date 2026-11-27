"""Every table, index and migration, applied once per database file and schema version.

One part of `shared.database.DatabaseManager`; every method runs on the manager
and reaches SQLite through `self._get_connection()`.
"""

import sqlite3
import logging
import threading
from typing import Dict, Optional
from shared.url_utils import validate_youtube_video_id


logger = logging.getLogger(__name__)


# Schema setup is idempotent but not free: it rewrites the FTS5 triggers and so
# takes a write lock every time it runs. Once per file per process is enough,
# keyed by the `schema_version` this process last reconciled the file at.
_SCHEMA_READY: dict[str, int] = {}
_SCHEMA_LOCK = threading.Lock()

# The background lossless upgrader kept its queue here. It never found a
# verifiable copy of a commercial recording and was removed.
RETIRED_TABLES = (
    "lossless_upgrade_jobs",
    "lossless_provider_cache",
    "lossless_daily_budget",
)

# Where each track's audio came from, recorded by that upgrader. Nothing
# writes or reads them any more.
RETIRED_TRACK_COLUMNS = (
    "compressed",
    "audio_source",
    "audio_source_url",
    "audio_license_url",
    "audio_identity_verified",
)

# Note: Migration definitions for schema evolution
_TRACKS_COLUMNS = {
    "local_mtime_ns": "INTEGER",
    "youtube_id": "TEXT",
    "musicbrainz_id": "TEXT",
    "isrc": "TEXT",
    "album_artist": "TEXT",
    "cover_source": "TEXT",
    "metadata_modified_by_user": "BOOLEAN DEFAULT 0",
    "audio_quality": "TEXT DEFAULT 'unknown'",
    "disc_number": "INTEGER",
    "disc_total": "INTEGER",
    "is_compilation": "BOOLEAN NOT NULL DEFAULT 0",
    "album_id": "TEXT",
    # Podcast episodes live in the same manifest as songs. Without this the
    # projection forgot which was which, and a show came back out of the
    # database indistinguishable from an album.
    "media_kind": "TEXT",
    "podcast_feed_id": "TEXT",
    "podcast_episode_guid": "TEXT",
    "podcast_rss_url": "TEXT",
    "artists_json": "TEXT",
    # When the song joined this library. Distinct from `last_updated`, which
    # moves whenever a row is rewritten and is therefore identical across every
    # track of a library that has been migrated once. Left NULL on upgrade so
    # `backfill_added_at` can date the existing rows from their audio files
    # instead of stamping the whole library with the moment of the upgrade.
    "added_at": "TIMESTAMP",
}

_YT_CACHE_COLUMNS = {
    "confidence": "REAL",
    "confidence_reason": "TEXT",
    "candidates_json": "TEXT",
    "failure_state": "TEXT",
    "verified_at": "TIMESTAMP",
    # The running time the resolution was made for. None: made without one,
    # so a caller that knows it may correct the row for everyone.
    "requested_duration": "INTEGER",
}

_PAIRING_COLUMNS = {
    "auto_confirm": "INTEGER NOT NULL DEFAULT 0",
    "display_active": "INTEGER NOT NULL DEFAULT 0",
    # Whose device is being paired. The minted token inherits it, so a paired
    # phone acts as its owner rather than borrowing somebody else's identity.
    "user_id": "TEXT",
}

_AUTH_TOKEN_COLUMNS = {
    "user_id": "TEXT",
}


class SchemaMixin:

    # ------------------------------------------------------------------
    # Schema setup helpers (static to keep _init_db readable)
    # ------------------------------------------------------------------

    @staticmethod
    def _create_tracks_table(conn):
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tracks (
                id TEXT PRIMARY KEY,
                title TEXT,
                artist TEXT,
                album TEXT,
                duration INTEGER,
                file_hash TEXT,
                original_filename TEXT,
                file_size INTEGER,
                bitrate INTEGER,
                format TEXT,
                cover_art_key TEXT,
                year INTEGER,
                genre TEXT,
                track_number INTEGER,
                disc_number INTEGER,
                disc_total INTEGER,
                is_compilation BOOLEAN NOT NULL DEFAULT 0,
                album_id TEXT,
                media_kind TEXT,
                podcast_feed_id TEXT,
                podcast_episode_guid TEXT,
                podcast_rss_url TEXT,
                artists_json TEXT,
                is_local BOOLEAN,
                local_path TEXT,
                local_mtime_ns INTEGER,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                musicbrainz_id TEXT,
                isrc TEXT,
                album_artist TEXT,
                cover_source TEXT,
                metadata_modified_by_user BOOLEAN DEFAULT 0,
                youtube_id TEXT,
                audio_quality TEXT DEFAULT 'unknown'
            )
        """)

    @staticmethod
    def _create_library_info_table(conn):
        conn.execute("""
            CREATE TABLE IF NOT EXISTS library_info (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        """)

    @staticmethod
    def _create_library_state_tables(conn):
        """Persist the complete per-user library, not only its track index."""
        conn.execute("""
            CREATE TABLE IF NOT EXISTS library_state (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                canonical INTEGER NOT NULL DEFAULT 0,
                revision INTEGER NOT NULL DEFAULT 0,
                version INTEGER NOT NULL DEFAULT 1,
                last_updated TEXT NOT NULL,
                settings_json TEXT NOT NULL DEFAULT '{}',
                podcast_subscriptions_json TEXT NOT NULL DEFAULT '[]',
                podcast_episode_cache_json TEXT NOT NULL DEFAULT '{}'
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS playlists (
                name TEXT PRIMARY KEY,
                position INTEGER NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS library_tracks (
                track_id TEXT PRIMARY KEY,
                position INTEGER NOT NULL,
                FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS playlist_tracks (
                playlist_name TEXT NOT NULL,
                position INTEGER NOT NULL,
                track_id TEXT NOT NULL,
                PRIMARY KEY (playlist_name, position),
                FOREIGN KEY (playlist_name) REFERENCES playlists(name) ON DELETE CASCADE
            )
        """)
        from shared.collection import create_schema
        create_schema(conn)
        # Track ids used to be content hashes, so a lossless technical rewrite
        # could change the id without changing the song.  Keep the old names as
        # durable aliases: stale clients and portable exports can then be
        # normalized instead of reintroducing dead playlist entries.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS track_id_aliases (
                old_track_id TEXT PRIMARY KEY,
                new_track_id TEXT NOT NULL
            )
        """)

    @staticmethod
    def _track_id_aliases(conn, incoming: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        aliases = {
            str(row[0]): str(row[1])
            for row in conn.execute(
                "SELECT old_track_id, new_track_id FROM track_id_aliases"
            ).fetchall()
            if row[0] and row[1] and str(row[0]) != str(row[1])
        }
        aliases.update({
            str(old): str(new)
            for old, new in (incoming or {}).items()
            if old and new and str(old) != str(new)
        })

        resolved: Dict[str, str] = {}
        for old in aliases:
            value = old
            seen = set()
            while value in aliases and value not in seen:
                seen.add(value)
                value = aliases[value]
            if value not in seen and value != old:
                resolved[old] = value
        return resolved

    @staticmethod
    def _create_fts5_triggers(conn):
        try:
            conn.execute("""
                CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
                    id UNINDEXED,
                    title,
                    artist,
                    album,
                    content='tracks',
                    content_rowid='rowid'
                )
            """)
            conn.execute("DROP TRIGGER IF EXISTS tracks_ai")
            conn.execute("""
                CREATE TRIGGER tracks_ai AFTER INSERT ON tracks BEGIN
                    INSERT INTO tracks_fts(rowid, id, title, artist, album)
                    VALUES (new.rowid, new.id, new.title, new.artist, new.album);
                END
            """)
            conn.execute("DROP TRIGGER IF EXISTS tracks_ad")
            conn.execute("""
                CREATE TRIGGER tracks_ad AFTER DELETE ON tracks BEGIN
                    INSERT INTO tracks_fts(tracks_fts, rowid, id, title, artist, album)
                    VALUES('delete', old.rowid, old.id, old.title, old.artist, old.album);
                END
            """)
            conn.execute("DROP TRIGGER IF EXISTS tracks_au")
            conn.execute("""
                CREATE TRIGGER tracks_au AFTER UPDATE ON tracks BEGIN
                    INSERT INTO tracks_fts(tracks_fts, rowid, id, title, artist, album)
                    VALUES('delete', old.rowid, old.id, old.title, old.artist, old.album);
                    INSERT INTO tracks_fts(rowid, id, title, artist, album)
                    VALUES (new.rowid, new.id, new.title, new.artist, new.album);
                END
            """)
        except sqlite3.OperationalError:
            pass  # Note: FTS5 not available

    @staticmethod
    def _migrate_tracks_columns(conn):
        cursor = conn.execute("PRAGMA table_info(tracks)")
        columns = [row[1] for row in cursor.fetchall()]
        for col, defn in _TRACKS_COLUMNS.items():
            if col not in columns:
                conn.execute(f"ALTER TABLE tracks ADD COLUMN {col} {defn}")
        for col in RETIRED_TRACK_COLUMNS:
            if col in columns:
                conn.execute(f"ALTER TABLE tracks DROP COLUMN {col}")

    @staticmethod
    def _create_youtube_cache_table(conn):
        conn.execute("""
            CREATE TABLE IF NOT EXISTS youtube_resolution_cache (
                artist TEXT NOT NULL,
                title TEXT NOT NULL,
                youtube_id TEXT NOT NULL,
                duration INTEGER,
                thumbnail TEXT,
                webpage_url TEXT,
                channel TEXT,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                confidence REAL,
                confidence_reason TEXT,
                candidates_json TEXT,
                failure_state TEXT,
                verified_at TIMESTAMP,
                PRIMARY KEY (artist, title)
            )
        """)
        cursor = conn.execute("PRAGMA table_info(youtube_resolution_cache)")
        yt_cols = [row[1] for row in cursor.fetchall()]
        for col, defn in _YT_CACHE_COLUMNS.items():
            if col not in yt_cols:
                conn.execute(f"ALTER TABLE youtube_resolution_cache ADD COLUMN {col} {defn}")

    @staticmethod
    def _create_related_mix_cache_table(conn):
        """Persistent cache for YouTube related/mix expansions keyed by seed video id.

        Replaces the in-memory 5-min dict in the downloader route. Related mixes
        change slowly (days), so a 7-day TTL here turns the second-and-later
        request for any seed into a sub-millisecond SQLite read — across
        sessions, restarts, and devices.
        """
        conn.execute("""
            CREATE TABLE IF NOT EXISTS related_mix_cache (
                video_id TEXT PRIMARY KEY,
                results_json TEXT NOT NULL,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_related_mix_cache_updated
            ON related_mix_cache (last_updated)
        """)

    @staticmethod
    def _create_stream_url_cache_table(conn):
        """Persistent cache for resolved googlevideo URLs, keyed by video id.

        A signed stream URL is good for about six hours, but resolving one costs
        a multi-second yt-dlp extraction — and on a relayed station that
        extraction is roughly 1.5 MB dragged through the residential egress. The
        in-process memo only survived five minutes and died with the process, so
        a station that had already paid for a URL paid again on the next
        restart, and again five minutes later.

        ``egress`` is stored because it is part of the key in practice: the CDN
        signs the resolving IP into the URL, so one resolved through the relay is
        worthless to a direct fetch and vice versa. Rows whose egress no longer
        matches the running configuration are ignored rather than served.
        """
        conn.execute("""
            CREATE TABLE IF NOT EXISTS stream_url_cache (
                video_id TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                egress TEXT NOT NULL,
                resolved_at REAL NOT NULL,
                expires_at REAL NOT NULL
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_stream_url_cache_expires
            ON stream_url_cache (expires_at)
        """)

    @staticmethod
    def _create_users_table(conn):
        """Accounts served by this instance.

        ``password_hash`` is nullable on purpose: a fresh install migrated from
        single-user has exactly one account with no password, which is what
        keeps the login screen out of the way until a second person exists.
        """
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                username_folded TEXT NOT NULL UNIQUE,
                display_name TEXT,
                avatar_color TEXT,
                password_hash TEXT,
                role TEXT NOT NULL DEFAULT 'member',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                disabled_at TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_users_role
            ON users (role)
        """)

    @staticmethod
    def _create_invites_table(conn):
        """One-time links that let somebody create their own account.

        Only the SHA-256 of the token is stored, so a leaked database does not
        hand out working invitations.
        """
        conn.execute("""
            CREATE TABLE IF NOT EXISTS invites (
                id TEXT PRIMARY KEY,
                token_hash TEXT NOT NULL UNIQUE,
                display_name TEXT,
                role TEXT NOT NULL DEFAULT 'member',
                created_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NOT NULL,
                used_at TIMESTAMP,
                created_user_id TEXT,
                revoked_at TIMESTAMP
            )
        """)

    @staticmethod
    def _create_auth_tables(conn):
        conn.execute("""
            CREATE TABLE IF NOT EXISTS agent_tokens (
                id TEXT PRIMARY KEY,
                name TEXT,
                token_hash TEXT NOT NULL UNIQUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_used_at TIMESTAMP,
                revoked_at TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS auth_tokens (
                id TEXT PRIMARY KEY,
                name TEXT,
                token_hash TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL,
                device_type TEXT,
                scopes TEXT NOT NULL,
                user_id TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_used_at TIMESTAMP,
                expires_at TIMESTAMP,
                revoked_at TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_auth_tokens_kind
            ON auth_tokens (kind)
        """)
        # A pre-multiuser auth_tokens table has no user_id; add it before the
        # index that depends on it.
        cursor = conn.execute("PRAGMA table_info(auth_tokens)")
        auth_columns = [row[1] for row in cursor.fetchall()]
        for col, defn in _AUTH_TOKEN_COLUMNS.items():
            if col not in auth_columns:
                conn.execute(f"ALTER TABLE auth_tokens ADD COLUMN {col} {defn}")
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_auth_tokens_user
            ON auth_tokens (user_id)
        """)

    @staticmethod
    def _create_subsonic_credentials_table(conn):
        """One Subsonic credential per account, stored so it can be read back.

        Every other secret in this file lives as a hash, and this one cannot:
        the Subsonic handshake sends ``md5(password + salt)``, which the server
        can only check by computing the same thing. The ciphertext here is
        useless without the key file the config directory holds, and the
        credential is never the account password — it is minted for this
        protocol alone and revoked on its own.
        """
        conn.execute("""
            CREATE TABLE IF NOT EXISTS subsonic_credentials (
                user_id TEXT PRIMARY KEY,
                secret_enc TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_used_at TIMESTAMP,
                last_client TEXT
            )
        """)

    @staticmethod
    def _create_pairing_table(conn):
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pairing_sessions (
                id TEXT PRIMARY KEY,
                code TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL,
                device_name TEXT,
                device_type TEXT,
                requested_scopes TEXT NOT NULL,
                granted_scopes TEXT NOT NULL,
                auto_confirm INTEGER NOT NULL DEFAULT 0,
                display_active INTEGER NOT NULL DEFAULT 0,
                owner_confirmed_at TIMESTAMP,
                claimed_at TIMESTAMP,
                completed_at TIMESTAMP,
                expires_at TIMESTAMP NOT NULL,
                auth_token_id TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_pairing_sessions_status
            ON pairing_sessions (status)
        """)
        cursor = conn.execute("PRAGMA table_info(pairing_sessions)")
        pairing_columns = [row[1] for row in cursor.fetchall()]
        for col, defn in _PAIRING_COLUMNS.items():
            if col not in pairing_columns:
                conn.execute(f"ALTER TABLE pairing_sessions ADD COLUMN {col} {defn}")

    @staticmethod
    def _create_tv_auth_table(conn):
        """Short-lived Smart TV authorization requests; stores only SHA-256 hashes."""
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tv_auth_requests (
                id TEXT PRIMARY KEY,
                code_hash TEXT NOT NULL UNIQUE,
                handle_hash TEXT NOT NULL UNIQUE,
                device_name TEXT NOT NULL,
                status TEXT NOT NULL,
                approved_user_id TEXT,
                auth_token_id TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NOT NULL,
                approved_at TIMESTAMP,
                redeemed_at TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_tv_auth_requests_status
            ON tv_auth_requests (status)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_tv_auth_requests_expires
            ON tv_auth_requests (expires_at)
        """)

    @staticmethod
    def _create_lyrics_table(conn):
        """Lyrics cache keyed by track id. Kept separate from the canonical
        library snapshot because lyrics are local-only and survive replaces."""
        conn.execute("""
            CREATE TABLE IF NOT EXISTS track_lyrics (
                track_id TEXT PRIMARY KEY,
                synced TEXT,
                plain TEXT,
                instrumental INTEGER NOT NULL DEFAULT 0,
                source TEXT,
                checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        columns = {row[1] for row in conn.execute("PRAGMA table_info(track_lyrics)")}
        if "synced_duration" not in columns:
            # The running time the timed lines were written against, so a
            # recording of another length can be told apart from the one they
            # fit. Older rows have none and are re-resolved when next read.
            conn.execute("ALTER TABLE track_lyrics ADD COLUMN synced_duration INTEGER")
        if "rich_synced" not in columns:
            # Optional word/syllable timing JSON from background enrichment.
            # Kept separate from line LRC (`synced`) so enrichment never
            # reduces line coverage or leaks attributed providers to Subsonic.
            conn.execute("ALTER TABLE track_lyrics ADD COLUMN rich_synced TEXT")
        if "rich_source" not in columns:
            # Enrichment state: NULL (not yet tried), "none:v1" (checked, no
            # rich timing found), or "<provider>:v1" / "lrc.red:ai:v1".
            conn.execute("ALTER TABLE track_lyrics ADD COLUMN rich_source TEXT")
        # How far a recording's timeline sits from its lyrics' timing, set by a
        # listener. Keyed by the audio (a video, or a file with no video), not by
        # the lyrics row, so a refreshed lookup keeps it and every copy of the
        # same upload shares it.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS lyrics_offsets (
                audio_key TEXT PRIMARY KEY,
                offset_ms INTEGER NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

    @staticmethod
    def _create_discovery_tables(conn):
        """Per-account recommendation signals and an undoable local audit."""
        conn.execute("""
            CREATE TABLE IF NOT EXISTS discovery_signals (
                identity TEXT PRIMARY KEY,
                media_type TEXT NOT NULL,
                title TEXT,
                artist TEXT,
                show_title TEXT,
                positive_weight REAL NOT NULL DEFAULT 0,
                negative_count REAL NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS discovery_signal_aliases (
                alias TEXT NOT NULL,
                identity TEXT NOT NULL,
                PRIMARY KEY (alias, identity)
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_discovery_signal_aliases_identity
            ON discovery_signal_aliases (identity)
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS discovery_events (
                id TEXT PRIMARY KEY,
                event TEXT NOT NULL,
                identity TEXT NOT NULL,
                media_type TEXT NOT NULL,
                positive_delta REAL NOT NULL DEFAULT 0,
                negative_delta REAL NOT NULL DEFAULT 0,
                payload_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                undone_at INTEGER
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_discovery_events_created
            ON discovery_events (created_at DESC)
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS discovery_artist_profile (
                artist_key TEXT PRIMARY KEY,
                literal_key TEXT NOT NULL,
                display_name TEXT NOT NULL,
                deezer_artist_id TEXT DEFAULT '',
                short_term_score REAL NOT NULL DEFAULT 0.0,
                long_term_score REAL NOT NULL DEFAULT 0.0,
                library_prior REAL NOT NULL DEFAULT 0.0,
                effective_score REAL NOT NULL DEFAULT 0.0,
                distinct_days INTEGER NOT NULL DEFAULT 0,
                distinct_tracks INTEGER NOT NULL DEFAULT 0,
                active_plays REAL NOT NULL DEFAULT 0.0,
                passive_plays REAL NOT NULL DEFAULT 0.0,
                early_skips REAL NOT NULL DEFAULT 0.0,
                last_listened_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_discovery_artist_profile_score
            ON discovery_artist_profile (effective_score DESC)
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS discovery_impressions (
                identity TEXT PRIMARY KEY,
                entity_type TEXT NOT NULL,
                first_shown_at INTEGER NOT NULL,
                last_shown_at INTEGER NOT NULL,
                shown_count INTEGER NOT NULL DEFAULT 1,
                last_interacted_at INTEGER NOT NULL DEFAULT 0
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_discovery_impressions_last_shown
            ON discovery_impressions (entity_type, last_shown_at DESC)
        """)

    @staticmethod
    def _create_discovery_graph_tables(conn):
        """Instance-shared artist similarity graph and release cache."""
        conn.execute("""
            CREATE TABLE IF NOT EXISTS artist_graph_nodes (
                deezer_artist_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                literal_key TEXT NOT NULL,
                folded_key TEXT NOT NULL,
                nb_fan INTEGER NOT NULL DEFAULT 0,
                picture_url TEXT DEFAULT '',
                mbid TEXT DEFAULT '',
                related_synced_at INTEGER NOT NULL DEFAULT 0,
                lastfm_synced_at INTEGER NOT NULL DEFAULT 0,
                listenbrainz_synced_at INTEGER NOT NULL DEFAULT 0,
                releases_synced_at INTEGER NOT NULL DEFAULT 0,
                top_tracks_synced_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            )
        """)
        if "listenbrainz_synced_at" not in {row[1] for row in conn.execute("PRAGMA table_info(artist_graph_nodes)")}:
            conn.execute("ALTER TABLE artist_graph_nodes ADD COLUMN listenbrainz_synced_at INTEGER NOT NULL DEFAULT 0")
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_artist_graph_nodes_literal
            ON artist_graph_nodes (literal_key)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_artist_graph_nodes_folded
            ON artist_graph_nodes (folded_key)
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS artist_similarity_edges (
                source_artist_id TEXT NOT NULL,
                target_artist_id TEXT NOT NULL,
                provider TEXT NOT NULL,
                rank_pos INTEGER NOT NULL,
                weight REAL NOT NULL,
                synced_at INTEGER NOT NULL,
                PRIMARY KEY (source_artist_id, target_artist_id, provider)
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_artist_sim_edges_source
            ON artist_similarity_edges (source_artist_id, provider)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_artist_sim_edges_target
            ON artist_similarity_edges (target_artist_id)
        """)
        legacy_releases = any(
            row[1] == "deezer_album_id" and row[5] == 1
            for row in conn.execute("PRAGMA table_info(artist_releases_cache)")
        )
        if legacy_releases:
            conn.execute("ALTER TABLE artist_releases_cache RENAME TO artist_releases_cache_legacy")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS artist_releases_cache (
                deezer_album_id TEXT NOT NULL,
                artist_deezer_id TEXT NOT NULL,
                title TEXT NOT NULL,
                artist_credit TEXT NOT NULL,
                credit_verified INTEGER NOT NULL DEFAULT 0,
                record_type TEXT NOT NULL,
                release_date TEXT NOT NULL,
                cover_url TEXT DEFAULT '',
                synced_at INTEGER NOT NULL,
                PRIMARY KEY (artist_deezer_id, deezer_album_id)
            )
        """)
        if legacy_releases:
            conn.execute("INSERT INTO artist_releases_cache SELECT * FROM artist_releases_cache_legacy")
            conn.execute("DROP TABLE artist_releases_cache_legacy")
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_artist_releases_album
            ON artist_releases_cache (deezer_album_id)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_artist_releases_owner_date
            ON artist_releases_cache (artist_deezer_id, release_date DESC)
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS artist_discography_snapshots (
                artist_deezer_id TEXT PRIMARY KEY,
                rows_json TEXT NOT NULL,
                synced_at INTEGER NOT NULL
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_artist_releases_date
            ON artist_releases_cache (release_date DESC)
        """)

    @staticmethod
    def _create_performance_indexes(conn):
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_tracks_album_sort
            ON tracks (album, album_artist, artist, track_number)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_library_tracks_position
            ON library_tracks (position, track_id)
        """)

    @staticmethod
    def _create_catalog_tables(conn):
        """Normalized per-account catalog plus user-owned track state."""
        conn.execute("""
            CREATE TABLE IF NOT EXISTS artists (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                name_key TEXT NOT NULL UNIQUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS albums (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                title_key TEXT NOT NULL,
                album_artist_id TEXT NOT NULL,
                album_artist TEXT NOT NULL,
                year INTEGER,
                genre TEXT,
                is_compilation INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (album_artist_id) REFERENCES artists(id)
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_albums_artist_title
            ON albums (album_artist_id, title_key)
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS track_artists (
                track_id TEXT NOT NULL,
                artist_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                PRIMARY KEY (track_id, position),
                UNIQUE (track_id, artist_id),
                FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE,
                FOREIGN KEY (artist_id) REFERENCES artists(id)
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_track_artists_artist
            ON track_artists (artist_id, track_id)
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS track_user_state (
                track_id TEXT PRIMARY KEY,
                play_count INTEGER NOT NULL DEFAULT 0 CHECK (play_count >= 0),
                rating INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
                last_played_at INTEGER,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
            )
        """)

    @staticmethod
    def _drop_retired_tables(conn):
        """Remove state left behind by features that no longer exist."""
        for table in RETIRED_TABLES:
            conn.execute(f"DROP TABLE IF EXISTS {table}")

    @staticmethod
    def _migrate_related_mix_cache(conn):
        """Discard legacy negative/invalid entries once, preserving new short TTLs."""
        conn.execute("CREATE TABLE IF NOT EXISTS cache_migrations (name TEXT PRIMARY KEY)")
        name = "related_mix_short_negative_ttl"
        if conn.execute("SELECT 1 FROM cache_migrations WHERE name = ?", (name,)).fetchone():
            return
        conn.execute("DELETE FROM related_mix_cache WHERE results_json = '[]'")
        invalid = [(row[0],) for row in conn.execute("SELECT video_id FROM related_mix_cache")
                   if not validate_youtube_video_id(row[0])]
        conn.executemany("DELETE FROM related_mix_cache WHERE video_id = ?", invalid)
        conn.execute("INSERT INTO cache_migrations (name) VALUES (?)", (name,))

    def _init_db(self):
        """Initialize the database schema.

        Both files get the full schema. The unused tables cost nothing, and it
        means a pre-multiuser `library.db` still answers auth queries while its
        instance rows are being migrated into `instance.db`.

        Runs at most once per file per process. The statements are idempotent,
        but recreating the FTS5 triggers is a schema write, so repeating it on
        every construction would take a write lock on every request.
        """
        key = str(self.db_path)
        with _SCHEMA_LOCK:
            with self._get_connection() as conn:
                # `schema_version` bumps on every DDL statement, so a file
                # altered by another process — or by a test — is re-reconciled
                # instead of being trusted because this process saw it once.
                if _SCHEMA_READY.get(key) == self._schema_version(conn):
                    return
                self._apply_schema(conn)
                _SCHEMA_READY[key] = self._schema_version(conn)

    @staticmethod
    def _schema_version(conn) -> int:
        return int(conn.execute("PRAGMA schema_version").fetchone()[0])

    def _apply_schema(self, conn):
        try:
            # IMMEDIATE: this transaction always writes, and a deferred one that
            # upgrades mid-flight gets SQLITE_BUSY without honouring busy_timeout.
            conn.execute("BEGIN IMMEDIATE")
            self._create_tracks_table(conn)
            self._create_library_info_table(conn)
            self._create_library_state_tables(conn)
            conn.execute("CREATE TABLE IF NOT EXISTS library_operations (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)")
            self._create_fts5_triggers(conn)
            self._migrate_tracks_columns(conn)
            self._create_youtube_cache_table(conn)
            self._create_related_mix_cache_table(conn)
            self._migrate_related_mix_cache(conn)
            self._create_stream_url_cache_table(conn)
            self._create_users_table(conn)
            self._create_invites_table(conn)
            self._create_auth_tables(conn)
            self._create_subsonic_credentials_table(conn)
            self._create_pairing_table(conn)
            self._create_tv_auth_table(conn)
            self._create_lyrics_table(conn)
            self._create_discovery_tables(conn)
            self._create_discovery_graph_tables(conn)
            self._create_catalog_tables(conn)
            self._create_performance_indexes(conn)
            self._drop_retired_tables(conn)
            self._sync_catalog_projection(conn)
            from shared.library_changes import install
            install(conn)
            from shared import library_search
            library_search.install(conn)
            # Builds the index once after an upgrade or a Python/Unicode change;
            # otherwise a single state read.
            library_search.sync(conn)
            conn.execute("COMMIT")
        except Exception as e:
            conn.execute("ROLLBACK")
            raise e
