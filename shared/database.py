"""
SQLite Database Manager for Soundsible.
Handles canonical library storage, rapid searching, and derived catalog data.
"""

import sqlite3
import json
import logging
import threading
import time
from pathlib import Path
from typing import List, Dict, Any, Optional, Iterable
from shared.models import Track, LibraryMetadata
from shared.runtime import get_config_dir

logger = logging.getLogger(__name__)

# How long a writer waits for a competing write lock before giving up. Every
# request builds a DatabaseManager (see `instance_db`), so brief overlap between
# a request and a background cache write is normal rather than exceptional.
BUSY_TIMEOUT_MS = 10_000

# Schema setup is idempotent but not free: it rewrites the FTS5 triggers and so
# takes a write lock every time it runs. Once per file per process is enough,
# keyed by the `schema_version` this process last reconciled the file at.
_SCHEMA_READY: dict[str, int] = {}
_SCHEMA_LOCK = threading.Lock()

#: One `DatabaseManager` per database file, shared process-wide. See
#: :func:`_manager_for`.
_MANAGERS: dict[str, "DatabaseManager"] = {}
_MANAGERS_LOCK = threading.Lock()

# The engine keeps two SQLite files. `instance.db` holds everything that belongs
# to the machine — accounts, credentials, pairing, and the content-addressed
# caches every user benefits from. `users/<id>/library.db` holds one person's
# track index. Both files carry the full schema so an older single-user
# `library.db` keeps working untouched while its instance rows are migrated out.
INSTANCE_DB_FILENAME = "instance.db"
USER_DB_FILENAME = "library.db"

# Tables that live in `instance.db` and get copied out of a pre-multiuser
# `library.db` on first boot (see shared/multiuser_migration.py).
INSTANCE_TABLES = (
    "users",
    "invites",
    "auth_tokens",
    "agent_tokens",
    "subsonic_credentials",
    "pairing_sessions",
    "youtube_resolution_cache",
    "related_mix_cache",
    "stream_url_cache",
    "track_lyrics",
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
    "audio_source": "TEXT",
    "audio_source_url": "TEXT",
    "audio_license_url": "TEXT",
    "audio_identity_verified": "BOOLEAN DEFAULT 0",
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
}

_YT_CACHE_COLUMNS = {
    "confidence": "REAL",
    "confidence_reason": "TEXT",
    "candidates_json": "TEXT",
    "failure_state": "TEXT",
    "verified_at": "TIMESTAMP",
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

# Podcast episodes share the tracks table with songs. Queries that describe a
# *music* library say so with this, rather than each one inventing its own idea
# of what counts.
_MUSIC_ONLY = "(t.media_kind IS NULL OR t.media_kind != 'podcast_episode')"


class DatabaseManager:
    def __init__(self, db_path: Optional[str] = None):
        """Open a database. With no path this is the bound user's library index;
        use :func:`instance_db` for accounts, credentials, and shared caches."""
        if db_path is None:
            from shared.user_context import user_config_dir

            self.db_path = user_config_dir() / USER_DB_FILENAME
        else:
            self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        # One connection per thread, reused. Opening a connection is not free —
        # it costs a file open plus three PRAGMA round trips — and resolving who
        # is calling a request touches this class several times before any
        # handler runs. Thread-local rather than shared because a sqlite3
        # connection may only be used from the thread that created it.
        self._connections = threading.local()

        self._init_db()

    def _get_connection(self):
        """This thread's connection to the database.

        Returned rather than newly opened, so `with db._get_connection() as
        conn:` keeps its existing meaning — sqlite3 connections commit on a
        clean exit and roll back on an exception, and neither closes them.
        """
        existing = getattr(self._connections, "conn", None)
        if existing is not None:
            return existing

        conn = sqlite3.connect(self.db_path, timeout=BUSY_TIMEOUT_MS / 1000)
        # busy_timeout first: it is per-connection and always succeeds, and
        # switching journal mode needs a lock. Without the timeout in place that
        # switch fails immediately instead of waiting for a concurrent reader.
        conn.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
        try:
            # Note: Enable WAL mode for high concurrency
            conn.execute("PRAGMA journal_mode=WAL")
        except sqlite3.OperationalError:
            # WAL belongs to the file, not the connection — another connection
            # has already set it.
            logger.debug("Could not set WAL on %s; already set by another connection", self.db_path)
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        self._connections.conn = conn
        return conn

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
                compressed BOOLEAN,
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
                audio_quality TEXT DEFAULT 'unknown',
                audio_source TEXT,
                audio_source_url TEXT,
                audio_license_url TEXT,
                audio_identity_verified BOOLEAN DEFAULT 0
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

    @staticmethod
    def _create_performance_indexes(conn):
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_tracks_album_sort
            ON tracks (album, album_artist, artist, track_number)
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
    def _flat_track_from_row(row: sqlite3.Row | tuple, columns: list[str] | None = None) -> Track:
        data = dict(row) if isinstance(row, sqlite3.Row) else dict(zip(columns or [], row))
        data.pop("last_updated", None)
        data.pop("album_id", None)
        stored_artists = data.pop("artists_json", None)
        data["compressed"] = bool(data.get("compressed"))
        data["is_local"] = bool(data.get("is_local"))
        data["metadata_modified_by_user"] = bool(data.get("metadata_modified_by_user"))
        data["audio_identity_verified"] = bool(data.get("audio_identity_verified"))
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

    @classmethod
    def _backfill_catalog_tables(cls, conn) -> None:
        """Populate new catalog tables once when upgrading a flat legacy DB."""
        has_tracks = conn.execute("SELECT 1 FROM tracks LIMIT 1").fetchone() is not None
        has_links = conn.execute("SELECT 1 FROM track_artists LIMIT 1").fetchone() is not None
        if not has_tracks or has_links:
            return
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM tracks").fetchall()
        tracks = [cls._flat_track_from_row(row) for row in rows]
        cls._replace_catalog_projection(conn, tracks)

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
            self._create_fts5_triggers(conn)
            self._migrate_tracks_columns(conn)
            self._create_youtube_cache_table(conn)
            self._create_related_mix_cache_table(conn)
            self._create_stream_url_cache_table(conn)
            self._create_users_table(conn)
            self._create_invites_table(conn)
            self._create_auth_tables(conn)
            self._create_subsonic_credentials_table(conn)
            self._create_pairing_table(conn)
            self._create_lyrics_table(conn)
            self._create_discovery_tables(conn)
            self._create_catalog_tables(conn)
            self._create_performance_indexes(conn)
            self._backfill_catalog_tables(conn)
            conn.execute("COMMIT")
        except Exception as e:
            conn.execute("ROLLBACK")
            raise e

    def replace_library(
        self,
        metadata: LibraryMetadata,
        *,
        id_replacements: Optional[Dict[str, str]] = None,
    ) -> int:
        """Atomically replace the canonical library and return its revision."""
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                replacement_state: Dict[str, sqlite3.Row] = {}
                conn.row_factory = sqlite3.Row
                for old_id, new_id in (id_replacements or {}).items():
                    if old_id == new_id:
                        continue
                    row = conn.execute(
                        "SELECT * FROM track_user_state WHERE track_id = ?", (old_id,)
                    ).fetchone()
                    if row is not None:
                        replacement_state[new_id] = row
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
                            audio_license_url, audio_identity_verified
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                            audio_identity_verified=excluded.audio_identity_verified
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
                        track.audio_license_url, track.audio_identity_verified
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

    def sync_from_metadata(self, metadata: LibraryMetadata):
        """Compatibility name for callers migrating a complete manifest."""
        return self.replace_library(metadata)

    def has_canonical_library(self) -> bool:
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT canonical FROM library_state WHERE singleton = 1"
            ).fetchone()
            return bool(row and row[0])

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
            return LibraryMetadata(
                version=int(state["version"]),
                tracks=tracks,
                playlists=playlists,
                settings=json.loads(state["settings_json"]),
                last_updated=str(state["last_updated"]),
                podcast_subscriptions=json.loads(state["podcast_subscriptions_json"]),
                podcast_episode_cache=json.loads(state["podcast_episode_cache_json"]),
            )

    def get_all_tracks(self) -> List[Track]:
        """Fetch all tracks as Track objects."""
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute("SELECT * FROM tracks ORDER BY artist, album, track_number")
            return self._rows_to_tracks(conn, cursor.fetchall())

    def record_discovery_signal(
        self,
        *,
        event_id: str,
        event: str,
        identity: str,
        media_type: str,
        positive_delta: float,
        negative_delta: float,
        payload: Dict[str, Any],
        created_at: int,
    ) -> None:
        """Atomically append an event and fold it into the current profile."""
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                """
                INSERT INTO discovery_events (
                    id, event, identity, media_type, positive_delta,
                    negative_delta, payload_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    event,
                    identity,
                    media_type,
                    float(positive_delta),
                    float(negative_delta),
                    json.dumps(payload, sort_keys=True, ensure_ascii=False),
                    int(created_at),
                ),
            )
            conn.execute(
                """
                INSERT INTO discovery_signals (
                    identity, media_type, title, artist, show_title,
                    positive_weight, negative_count, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(identity) DO UPDATE SET
                    media_type=excluded.media_type,
                    title=COALESCE(NULLIF(excluded.title, ''), discovery_signals.title),
                    artist=COALESCE(NULLIF(excluded.artist, ''), discovery_signals.artist),
                    show_title=COALESCE(NULLIF(excluded.show_title, ''), discovery_signals.show_title),
                    positive_weight=MAX(0, discovery_signals.positive_weight + excluded.positive_weight),
                    negative_count=MAX(0, discovery_signals.negative_count + excluded.negative_count),
                    updated_at=excluded.updated_at
                """,
                (
                    identity,
                    media_type,
                    str(payload.get("title") or "")[:220],
                    str(payload.get("artist") or "")[:220],
                    str(payload.get("podcast_show_title") or "")[:220],
                    float(positive_delta),
                    float(negative_delta),
                    int(created_at),
                ),
            )
            conn.execute("COMMIT")

    def undo_discovery_signal(self, event_id: str, undone_at: int) -> bool:
        """Undo one event exactly once and reverse its aggregate deltas."""
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                """
                SELECT identity, positive_delta, negative_delta
                FROM discovery_events
                WHERE id = ? AND undone_at IS NULL
                """,
                (event_id,),
            ).fetchone()
            if row is None:
                conn.execute("ROLLBACK")
                return False
            conn.execute(
                "UPDATE discovery_events SET undone_at = ? WHERE id = ?",
                (int(undone_at), event_id),
            )
            conn.execute(
                """
                UPDATE discovery_signals
                SET positive_weight=MAX(0, positive_weight - ?),
                    negative_count=MAX(0, negative_count - ?),
                    updated_at=?
                WHERE identity=?
                """,
                (
                    float(row["positive_delta"]),
                    float(row["negative_delta"]),
                    int(undone_at),
                    str(row["identity"]),
                ),
            )
            conn.execute("COMMIT")
            return True

    def discovery_profile_policy_version(self) -> str:
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT value FROM library_info WHERE key = 'discovery_profile_policy'"
            ).fetchone()
            return str(row[0]) if row else ""

    def get_discovery_events(self) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT * FROM discovery_events ORDER BY created_at, id"
            ).fetchall()
            return [dict(row) for row in rows]

    def replace_discovery_signals(
        self,
        aggregates: Iterable[Dict[str, Any]],
        event_deltas: Dict[str, tuple[float, float]],
        *,
        policy_version: str,
    ) -> None:
        """Atomically rebuild derived recommendation weights, preserving audit rows."""
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM discovery_signals")
            for row in aggregates:
                conn.execute(
                    """
                    INSERT INTO discovery_signals (
                        identity, media_type, title, artist, show_title,
                        positive_weight, negative_count, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        str(row.get("identity") or ""),
                        str(row.get("media_type") or ""),
                        str(row.get("title") or "")[:220],
                        str(row.get("artist") or "")[:220],
                        str(row.get("show_title") or "")[:220],
                        float(row.get("positive_weight") or 0),
                        float(row.get("negative_weight") or 0),
                        int(row.get("updated_at") or 0),
                    ),
                )
            for event_id, (positive, negative) in event_deltas.items():
                conn.execute(
                    """
                    UPDATE discovery_events
                    SET positive_delta = ?, negative_delta = ?
                    WHERE id = ?
                    """,
                    (float(positive), float(negative), str(event_id)),
                )
            conn.execute(
                """
                INSERT OR REPLACE INTO library_info (key, value)
                VALUES ('discovery_profile_policy', ?)
                """,
                (str(policy_version),),
            )
            conn.execute("COMMIT")

    def get_discovery_signals(self) -> Dict[str, Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute("SELECT * FROM discovery_signals").fetchall()
            return {str(row["identity"]): dict(row) for row in rows}

    def clear_discovery_signals(self) -> None:
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM discovery_events")
            conn.execute("DELETE FROM discovery_signals")
            conn.execute("COMMIT")

    def search_tracks(self, query: str) -> List[Track]:
        """Fast search tracks using FTS5 or LIKE."""
        if not query:
            return self.get_all_tracks()
            
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            try:
                # Note: Try FTS5 first
                cursor = conn.execute("""
                    SELECT t.* FROM tracks t
                    JOIN tracks_fts f ON t.id = f.id
                    WHERE tracks_fts MATCH ?
                    ORDER BY rank
                """, (f"{query}*",))
                return self._rows_to_tracks(conn, cursor.fetchall())
            except sqlite3.OperationalError:
                # Note: Fallback to LIKE
                cursor = conn.execute("""
                    SELECT * FROM tracks 
                    WHERE title LIKE ? OR artist LIKE ? OR album LIKE ?
                    ORDER BY artist, title
                """, (f"%{query}%", f"%{query}%", f"%{query}%"))
                return self._rows_to_tracks(conn, cursor.fetchall())

    def get_track(self, track_id: str) -> Optional[Track]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
            return self._rows_to_tracks(conn, [row])[0] if row else None

    def get_albums(self) -> List[Dict[str, Any]]:
        """Fetch first-class albums without merging homonymous releases."""
        return self._albums_query("GROUP BY a.id ORDER BY a.album_artist, a.title")

    def get_album(self, catalog_album_id: str) -> Optional[Dict[str, Any]]:
        rows = self._albums_query("WHERE a.id = ? GROUP BY a.id", (catalog_album_id,))
        return rows[0] if rows else None

    def _albums_query(self, tail: str, params: tuple = ()) -> List[Dict[str, Any]]:
        """One album projection, reused by every ordering the clients ask for.

        `track_user_state` is keyed by track id, so the left join adds no rows
        and the aggregates below stay honest.

        `cover_track_id` is the album's opening track, ordered the way the disc
        is — the same row `getCoverArt` reaches through
        ``get_tracks_by_album_id(...)[0]``. Picking it here rather than letting
        each caller pick its own is what keeps the artwork on a grid identical
        to the artwork a Subsonic client fetches for that album.
        """
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(f"""
                SELECT a.id,
                       a.title,
                       a.title AS album,
                       a.album_artist,
                       a.album_artist AS artist,
                       a.album_artist_id,
                       a.year,
                       a.genre,
                       a.is_compilation,
                       (SELECT t2.id FROM tracks t2
                         WHERE t2.album_id = a.id
                         ORDER BY COALESCE(t2.disc_number, 1), COALESCE(t2.track_number, 0), t2.title
                         LIMIT 1) AS cover_track_id,
                       COUNT(t.id) AS track_count,
                       COALESCE(SUM(t.duration), 0) AS duration,
                       COALESCE(SUM(s.play_count), 0) AS play_count,
                       MAX(s.last_played_at) AS last_played_at,
                       MAX(t.last_updated) AS added_at,
                       AVG(s.rating) AS average_rating
                FROM albums a
                JOIN tracks t ON t.album_id = a.id
                LEFT JOIN track_user_state s ON s.track_id = t.id
                {tail}
            """, params).fetchall()
            return [dict(row) for row in rows]

    #: The orderings ``getAlbumList2`` understands, mapped to SQL. Public
    #: because it is the shared contract: the player's album grid offers these
    #: and nothing else, so the two surfaces cannot drift into disagreeing
    #: about what "by year" means. ``starred`` is missing on purpose:
    #: favourites are not in this database.
    ALBUM_ORDERINGS = {
        "newest": "MAX(t.last_updated) DESC, a.title",
        "alphabeticalByName": "a.title_key, a.album_artist",
        "alphabeticalByArtist": "a.album_artist, a.title_key",
        "byYear": "a.year, a.title_key",
        "byGenre": "a.album_artist, a.title_key",
        "random": "RANDOM()",
        "frequent": "COALESCE(SUM(s.play_count), 0) DESC, a.title_key",
        "recent": "MAX(s.last_played_at) DESC, a.title_key",
        "highest": "AVG(s.rating) DESC, a.title_key",
    }

    def get_albums_page(
        self,
        list_type: str = "alphabeticalByName",
        *,
        size: Optional[int] = 10,
        offset: int = 0,
        genre: Optional[str] = None,
        from_year: Optional[int] = None,
        to_year: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Albums in the order a client asked for, one page at a time.

        ``size=None`` means every match. Subsonic always names a page size, so
        that path is unchanged; the player's grid scrolls the whole library at
        once and would otherwise have to page a list it is about to render in
        full anyway.
        """
        order = self.ALBUM_ORDERINGS.get(list_type)
        if order is None:
            return []

        filters: List[str] = []
        params: List[Any] = []
        having = ""

        if list_type == "byGenre":
            if not genre:
                return []
            filters.append("a.genre = ? COLLATE NOCASE")
            params.append(genre)
        elif list_type == "byYear":
            low, high = from_year, to_year
            if low is None or high is None:
                return []
            # `fromYear > toYear` is how the protocol asks for descending order.
            descending = low > high
            if descending:
                low, high = high, low
                order = "a.year DESC, a.title_key"
            filters.append("a.year IS NOT NULL AND a.year BETWEEN ? AND ?")
            params.extend([low, high])
        elif list_type == "recent":
            having = "HAVING MAX(s.last_played_at) IS NOT NULL"
        elif list_type == "frequent":
            having = "HAVING COALESCE(SUM(s.play_count), 0) > 0"
        elif list_type == "highest":
            having = "HAVING AVG(s.rating) IS NOT NULL"

        where = f"WHERE {' AND '.join(filters)}" if filters else ""
        limit = ""
        if size is not None:
            limit = " LIMIT ? OFFSET ?"
            params.extend([max(0, int(size)), max(0, int(offset))])
        return self._albums_query(
            f"{where} GROUP BY a.id {having} ORDER BY {order}{limit}",
            tuple(params),
        )

    def get_albums_by_ids(self, album_ids: List[str]) -> List[Dict[str, Any]]:
        if not album_ids:
            return []
        placeholders = ",".join("?" for _ in album_ids)
        return self._albums_query(
            f"WHERE a.id IN ({placeholders}) GROUP BY a.id ORDER BY a.album_artist, a.title",
            tuple(album_ids),
        )

    def get_artists(self) -> List[Dict[str, Any]]:
        """Fetch first-class artists with album and track counts."""
        return self._artists_query("GROUP BY ar.id ORDER BY ar.name")

    def get_artist(self, catalog_artist_id: str) -> Optional[Dict[str, Any]]:
        rows = self._artists_query("WHERE ar.id = ? GROUP BY ar.id", (catalog_artist_id,))
        return rows[0] if rows else None

    def _artists_query(self, tail: str, params: tuple = ()) -> List[Dict[str, Any]]:
        """One artist projection. `cover_track_id` matches `getCoverArt`'s pick
        for an artist — the first track they perform on — so the player's grid
        and a Subsonic client draw the same face."""
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(f"""
                SELECT ar.id,
                       ar.name,
                       COUNT(DISTINCT ta.track_id) AS track_count,
                       COUNT(DISTINCT al.id) AS album_count,
                       (SELECT t2.id FROM tracks t2
                         JOIN track_artists ta2 ON ta2.track_id = t2.id
                         WHERE ta2.artist_id = ar.id
                         ORDER BY t2.album, COALESCE(t2.disc_number, 1),
                                  COALESCE(t2.track_number, 0), t2.title
                         LIMIT 1) AS cover_track_id
                FROM artists ar
                LEFT JOIN track_artists ta ON ta.artist_id = ar.id
                LEFT JOIN albums al ON al.album_artist_id = ar.id
                {tail}
            """, params).fetchall()
            return [dict(row) for row in rows]

    def get_albums_by_artist_id(self, catalog_artist_id: str) -> List[Dict[str, Any]]:
        """The releases credited to this artist, newest year first."""
        return self._albums_query(
            "WHERE a.album_artist_id = ? GROUP BY a.id ORDER BY a.year, a.title_key",
            (catalog_artist_id,),
        )

    def search_albums(self, query: str, *, count: int = 20, offset: int = 0) -> List[Dict[str, Any]]:
        """Albums matching a query, compared on the folded keys the catalog stores."""
        from shared.library_catalog import entity_key

        like = f"%{entity_key(query)}%"
        return self._albums_query(
            "WHERE a.title_key LIKE ? OR LOWER(a.album_artist) LIKE ? "
            "GROUP BY a.id ORDER BY a.album_artist, a.title LIMIT ? OFFSET ?",
            (like, like, max(0, int(count)), max(0, int(offset))),
        )

    def search_artists(self, query: str, *, count: int = 20, offset: int = 0) -> List[Dict[str, Any]]:
        from shared.library_catalog import entity_key

        like = f"%{entity_key(query)}%"
        return self._artists_query(
            "WHERE ar.name_key LIKE ? GROUP BY ar.id ORDER BY ar.name LIMIT ? OFFSET ?",
            (like, max(0, int(count)), max(0, int(offset))),
        )

    def get_genres(self) -> List[Dict[str, Any]]:
        """Genres present in the library, with what carries each one."""
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(f"""
                SELECT TRIM(t.genre) AS name,
                       COUNT(*) AS song_count,
                       COUNT(DISTINCT t.album_id) AS album_count
                FROM tracks t
                WHERE t.genre IS NOT NULL AND TRIM(t.genre) != '' AND {_MUSIC_ONLY}
                GROUP BY TRIM(t.genre) COLLATE NOCASE
                ORDER BY name COLLATE NOCASE
            """).fetchall()
            return [dict(row) for row in rows]

    def get_years(self) -> List[Dict[str, Any]]:
        """Release years present in the catalog, newest first.

        Read off `albums` rather than `tracks`: the year of a release belongs to
        the release, and counting it per track would rank a long album above a
        year that holds several short ones.
        """
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute("""
                SELECT a.year AS year,
                       COUNT(DISTINCT a.id) AS album_count,
                       COUNT(t.id) AS track_count
                FROM albums a
                JOIN tracks t ON t.album_id = a.id
                WHERE a.year IS NOT NULL
                GROUP BY a.year
                ORDER BY a.year DESC
            """).fetchall()
            return [dict(row) for row in rows]

    def get_tracks_by_genre(self, genre: str, *, count: int = 10, offset: int = 0) -> List[Track]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(f"""
                SELECT t.* FROM tracks t
                WHERE t.genre = ? COLLATE NOCASE AND {_MUSIC_ONLY}
                ORDER BY t.artist, t.album, COALESCE(t.disc_number, 1), COALESCE(t.track_number, 0)
                LIMIT ? OFFSET ?
            """, (genre, max(0, int(count)), max(0, int(offset)))).fetchall()
            return self._rows_to_tracks(conn, rows)

    def get_random_tracks(
        self,
        *,
        size: int = 10,
        genre: Optional[str] = None,
        from_year: Optional[int] = None,
        to_year: Optional[int] = None,
    ) -> List[Track]:
        filters = [_MUSIC_ONLY]
        params: List[Any] = []
        if genre:
            filters.append("t.genre = ? COLLATE NOCASE")
            params.append(genre)
        if from_year is not None:
            filters.append("t.year >= ?")
            params.append(int(from_year))
        if to_year is not None:
            filters.append("t.year <= ?")
            params.append(int(to_year))
        params.append(max(0, int(size)))
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(f"""
                SELECT t.* FROM tracks t
                WHERE {' AND '.join(filters)}
                ORDER BY RANDOM() LIMIT ?
            """, tuple(params)).fetchall()
            return self._rows_to_tracks(conn, rows)

    def count_tracks_per_album(self, track_ids: List[str]) -> Dict[str, int]:
        """How many of these tracks each album holds, as ``album_id -> count``.

        One query so a caller deciding "is this whole album starred?" over a
        page of fifty albums does not ask fifty times.
        """
        if not track_ids:
            return {}
        placeholders = ",".join("?" for _ in track_ids)
        with self._get_connection() as conn:
            rows = conn.execute(f"""
                SELECT album_id, COUNT(*) FROM tracks
                WHERE id IN ({placeholders}) AND album_id IS NOT NULL
                GROUP BY album_id
            """, tuple(track_ids)).fetchall()
            return {str(row[0]): int(row[1]) for row in rows}

    def get_tracks_by_ids(self, track_ids: List[str]) -> List[Track]:
        """Tracks for a list of ids, in the order the caller gave them."""
        if not track_ids:
            return []
        placeholders = ",".join("?" for _ in track_ids)
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                f"SELECT * FROM tracks WHERE id IN ({placeholders})", tuple(track_ids)
            ).fetchall()
            by_id = {track.id: track for track in self._rows_to_tracks(conn, rows)}
            return [by_id[track_id] for track_id in track_ids if track_id in by_id]

    def get_tracks_by_album(self, album_name: str, artist_name: str = None) -> List[Track]:
        """
        Fetch all tracks for a specific album.
        If artist_name is provided, it's used as a secondary filter for identically named albums.
        """
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            if artist_name:
                cursor = conn.execute("""
                    SELECT * FROM tracks 
                    WHERE album = ? AND (album_artist = ? OR artist = ?)
                    ORDER BY track_number
                """, (album_name, artist_name, artist_name))
            else:
                cursor = conn.execute("""
                    SELECT * FROM tracks 
                    WHERE album = ?
                    ORDER BY track_number
                """, (album_name,))
            return self._rows_to_tracks(conn, cursor.fetchall())

    def get_tracks_by_album_id(self, catalog_album_id: str) -> List[Track]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute("""
                SELECT * FROM tracks
                WHERE album_id = ?
                ORDER BY COALESCE(disc_number, 1), COALESCE(track_number, 0), title
            """, (catalog_album_id,)).fetchall()
            return self._rows_to_tracks(conn, rows)

    def get_tracks_by_artist_id(self, catalog_artist_id: str) -> List[Track]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute("""
                SELECT t.*
                FROM tracks t
                JOIN track_artists ta ON ta.track_id = t.id
                WHERE ta.artist_id = ?
                ORDER BY t.album, COALESCE(t.disc_number, 1), COALESCE(t.track_number, 0), t.title
            """, (catalog_artist_id,)).fetchall()
            return self._rows_to_tracks(conn, rows)

    @staticmethod
    def _artist_names_by_track(conn, track_ids: list[str]) -> Dict[str, List[str]]:
        if not track_ids:
            return {}
        placeholders = ",".join("?" for _ in track_ids)
        rows = conn.execute(f"""
            SELECT ta.track_id, ar.name
            FROM track_artists ta
            JOIN artists ar ON ar.id = ta.artist_id
            WHERE ta.track_id IN ({placeholders})
            ORDER BY ta.track_id, ta.position
        """, track_ids).fetchall()
        result: Dict[str, List[str]] = {}
        for row in rows:
            result.setdefault(str(row["track_id"]), []).append(str(row["name"]))
        return result

    def _rows_to_tracks(self, conn, rows: list[sqlite3.Row]) -> List[Track]:
        artists = self._artist_names_by_track(conn, [str(row["id"]) for row in rows])
        return [self._row_to_track(row, artists.get(str(row["id"]))) for row in rows]

    def _row_to_track(self, row: sqlite3.Row, artists: Optional[List[str]] = None) -> Track:
        # Machine-local scan fields live only in SQLite and are restored here.
        data = dict(row)
        data.pop("last_updated", None)
        data.pop("album_id", None)
        stored_artists = data.pop("artists_json", None)
        data["compressed"] = bool(data.get("compressed"))
        data["is_local"] = bool(data.get("is_local"))
        data["metadata_modified_by_user"] = bool(data.get("metadata_modified_by_user"))
        data["audio_identity_verified"] = bool(data.get("audio_identity_verified"))
        data["is_compilation"] = bool(data.get("is_compilation"))
        data["artists"] = artists or (json.loads(stored_artists) if stored_artists else None)
        return Track.from_dict(data)

    def get_track_user_state(self, track_id: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            exists = conn.execute("SELECT 1 FROM tracks WHERE id = ?", (track_id,)).fetchone()
            if exists is None:
                return None
            row = conn.execute("""
                SELECT play_count, rating, last_played_at
                FROM track_user_state WHERE track_id = ?
            """, (track_id,)).fetchone()
            return dict(row) if row else {"play_count": 0, "rating": None, "last_played_at": None}

    def get_track_user_states(self, track_ids: List[str]) -> Dict[str, Dict[str, Any]]:
        """Play count, rating and last-played for a whole list, in one query.

        Serializing a page of songs asks for this per track; one round trip per
        row is what turns a fifty-song album into fifty queries.
        """
        if not track_ids:
            return {}
        placeholders = ",".join("?" for _ in track_ids)
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(f"""
                SELECT track_id, play_count, rating, last_played_at
                FROM track_user_state WHERE track_id IN ({placeholders})
            """, tuple(track_ids)).fetchall()
            found = {str(row["track_id"]): dict(row) for row in rows}
        return {
            track_id: found.get(track_id, {"play_count": 0, "rating": None, "last_played_at": None})
            for track_id in track_ids
        }

    def search_music_tracks(self, query: str, *, count: int = 20, offset: int = 0) -> List[Track]:
        """Track search restricted to music, paged the way clients page it."""
        like = f"%{query}%"
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(f"""
                SELECT t.* FROM tracks t
                WHERE {_MUSIC_ONLY}
                  AND (t.title LIKE ? OR t.artist LIKE ? OR t.album LIKE ?)
                ORDER BY t.artist, t.album, COALESCE(t.disc_number, 1), COALESCE(t.track_number, 0), t.title
                LIMIT ? OFFSET ?
            """, (like, like, like, max(0, int(count)), max(0, int(offset)))).fetchall()
            return self._rows_to_tracks(conn, rows)

    def set_track_rating(self, track_id: str, rating: Optional[int]) -> bool:
        if rating is not None and (not isinstance(rating, int) or isinstance(rating, bool) or not 1 <= rating <= 5):
            raise ValueError("rating must be null or an integer from 1 to 5")
        with self._get_connection() as conn:
            if conn.execute("SELECT 1 FROM tracks WHERE id = ?", (track_id,)).fetchone() is None:
                return False
            conn.execute("""
                INSERT INTO track_user_state (track_id, rating)
                VALUES (?, ?)
                ON CONFLICT(track_id) DO UPDATE SET
                    rating=excluded.rating,
                    updated_at=CURRENT_TIMESTAMP
            """, (track_id, rating))
            return True

    def record_track_play(self, track_id: str, played_at: int) -> bool:
        if not isinstance(played_at, int) or isinstance(played_at, bool) or played_at < 0:
            raise ValueError("played_at must be a non-negative Unix timestamp")
        with self._get_connection() as conn:
            if conn.execute("SELECT 1 FROM tracks WHERE id = ?", (track_id,)).fetchone() is None:
                return False
            conn.execute("""
                INSERT INTO track_user_state (track_id, play_count, last_played_at)
                VALUES (?, 1, ?)
                ON CONFLICT(track_id) DO UPDATE SET
                    play_count=track_user_state.play_count + 1,
                    last_played_at=MAX(COALESCE(track_user_state.last_played_at, 0), excluded.last_played_at),
                    updated_at=CURRENT_TIMESTAMP
            """, (track_id, played_at))
            return True

    def get_stats(self) -> Dict[str, int]:
        """Track counts in one pass.

        `is_local` and `compressed` are unindexed, so each of the three separate
        COUNT(*) queries this replaced was its own full scan — on a liveness
        probe that the desktop shell and the player poll continuously.
        """
        with self._get_connection() as conn:
            row = conn.execute(
                """
                SELECT COUNT(*),
                       COALESCE(SUM(is_local = 1), 0),
                       COALESCE(SUM(compressed = 1), 0)
                FROM tracks
                """
            ).fetchone()
            # `cloud` stays an approximation, as before.
            return {"tracks": row[0], "local": row[1], "cloud": row[2]}

    def clear_all(self):
        """Wipe all data from the local database."""
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute("DELETE FROM track_artists")
                conn.execute("DELETE FROM track_user_state")
                conn.execute("DELETE FROM tracks")
                conn.execute("DELETE FROM albums")
                conn.execute("DELETE FROM artists")
                conn.execute("DELETE FROM library_info")
                conn.execute("DELETE FROM library_tracks")
                conn.execute("DELETE FROM playlist_tracks")
                conn.execute("DELETE FROM playlists")
                conn.execute("DELETE FROM library_state")
                # Note: FTS5 table cleanup
                try:
                    conn.execute("DELETE FROM tracks_fts")
                except sqlite3.OperationalError:
                    pass
                conn.execute("COMMIT")
                conn.execute("VACUUM")
            except Exception as e:
                conn.execute("ROLLBACK")
                raise e

    # Note: Resolved stream URL cache

    def get_cached_stream_url(self, video_id: str, egress: str) -> Optional[Dict[str, Any]]:
        """Return a live cached stream URL for this video and egress, or None.

        Expired rows are reported as a miss and left for `prune_stream_urls` to
        clear; a read path should not pay for a write.
        """
        if not video_id or not egress:
            return None
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT url, egress, resolved_at, expires_at
                FROM stream_url_cache
                WHERE video_id = ? AND egress = ? AND expires_at > ?
            """, (video_id, egress, time.time())).fetchone()
            return dict(row) if row else None

    def set_cached_stream_url(
        self,
        video_id: str,
        url: str,
        egress: str,
        resolved_at: float,
        expires_at: float,
    ) -> None:
        """Remember a resolved stream URL until its own signature expires."""
        if not video_id or not url or not egress:
            return
        if expires_at <= time.time():
            return
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute("""
                    INSERT INTO stream_url_cache (video_id, url, egress, resolved_at, expires_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(video_id) DO UPDATE SET
                        url=excluded.url,
                        egress=excluded.egress,
                        resolved_at=excluded.resolved_at,
                        expires_at=excluded.expires_at
                """, (video_id, url, egress, resolved_at, expires_at))
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise

    def invalidate_cached_stream_url(self, video_id: str) -> None:
        """Drop a stream URL the CDN has started rejecting."""
        if not video_id:
            return
        with self._get_connection() as conn:
            conn.execute("DELETE FROM stream_url_cache WHERE video_id = ?", (video_id,))

    def prune_stream_urls(self) -> int:
        """Delete expired rows. Returns how many went."""
        with self._get_connection() as conn:
            cursor = conn.execute("DELETE FROM stream_url_cache WHERE expires_at <= ?", (time.time(),))
            return cursor.rowcount or 0

    # Note: Youtube resolution cache

    def get_cached_resolution(self, artist: str, title: str) -> Optional[Dict[str, Any]]:
        """Fetch a cached YouTube resolution by artist and title."""
        if not artist or not title:
            return None
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT youtube_id as id, duration, thumbnail, webpage_url, channel, artist, title,
                       confidence, confidence_reason, candidates_json, failure_state, verified_at
                FROM youtube_resolution_cache
                WHERE artist = ? AND title = ?
            """, (artist, title)).fetchone()
            if not row:
                return None
            d = dict(row)
            if d.get("candidates_json"):
                try:
                    import json as _json
                    d["candidates"] = _json.loads(d["candidates_json"])
                except Exception:
                    d["candidates"] = []
            else:
                d["candidates"] = []
            return d

    def set_cached_resolution(self, artist: str, title: str, result: Dict[str, Any]):
        """Save a YouTube resolution to the cache. Allows empty id for failure states."""
        if not artist or not title or not result:
            return
        # Require a video id unless this is explicitly a failure state record
        if not result.get("id") and not result.get("failure_state"):
            return
        import json as _json
        candidates = result.get("candidates") or []
        candidates_json = _json.dumps(candidates) if candidates else None
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute("""
                    INSERT INTO youtube_resolution_cache
                    (artist, title, youtube_id, duration, thumbnail, webpage_url, channel,
                     confidence, confidence_reason, candidates_json, failure_state, verified_at,
                     last_updated)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    ON CONFLICT(artist, title) DO UPDATE SET
                    youtube_id=excluded.youtube_id,
                    duration=excluded.duration,
                    thumbnail=excluded.thumbnail,
                    webpage_url=excluded.webpage_url,
                    channel=excluded.channel,
                    confidence=excluded.confidence,
                    confidence_reason=excluded.confidence_reason,
                    candidates_json=excluded.candidates_json,
                    failure_state=excluded.failure_state,
                    verified_at=excluded.verified_at,
                    last_updated=CURRENT_TIMESTAMP
                """, (
                    artist,
                    title,
                    result.get("id"),
                    result.get("duration") or 0,
                    result.get("thumbnail") or "",
                    result.get("webpage_url") or "",
                    result.get("channel") or "",
                    result.get("confidence"),
                    result.get("confidence_reason"),
                    candidates_json,
                    result.get("failure_state"),
                ))
                conn.execute("COMMIT")
            except Exception as e:
                conn.execute("ROLLBACK")
                logger.warning("Error caching YouTube resolution: %s", e)

    # Note: Related/mix expansion cache (discover node engine)

    _RELATED_MIX_TTL_SEC = 7 * 24 * 3600

    def get_related_mix(self, video_id: str) -> Optional[list]:
        """Return cached related-mix results for a seed video id, or None if
        missing or older than the 7-day TTL. Results are returned as a parsed
        list (the same shape `get_related_videos` produces). The TTL check is
        done in SQL so it works with SQLite's text CURRENT_TIMESTAMP format."""
        if not video_id:
            return None
        cutoff = int(self._RELATED_MIX_TTL_SEC)
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                """
                SELECT results_json FROM related_mix_cache
                WHERE video_id = ?
                  AND last_updated >= datetime('now', ? || ' seconds')
                """,
                (video_id, f"-{cutoff}"),
            ).fetchone()
            if not row:
                return None
            try:
                return json.loads(row["results_json"])
            except Exception:
                return None

    def get_related_mixes(self, video_ids: Iterable[str]) -> Dict[str, list]:
        """Cached related mixes for several seeds, in one query.

        The feed and the Auto Mode planner both look up a handful of seeds in a
        loop; one round trip serves them all. Seeds that are missing or past the
        TTL are simply absent from the result, so callers can treat a missing
        key exactly like `get_related_mix` returning None.
        """
        wanted = [str(v) for v in video_ids if v]
        if not wanted:
            return {}
        cutoff = int(self._RELATED_MIX_TTL_SEC)
        placeholders = ",".join("?" * len(wanted))
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                f"""
                SELECT video_id, results_json FROM related_mix_cache
                WHERE video_id IN ({placeholders})
                  AND last_updated >= datetime('now', ? || ' seconds')
                """,
                (*wanted, f"-{cutoff}"),
            ).fetchall()
        found: Dict[str, list] = {}
        for row in rows:
            try:
                found[row["video_id"]] = json.loads(row["results_json"])
            except Exception:
                continue
        return found

    def set_related_mix(self, video_id: str, results: list) -> None:
        """Persist related-mix results for a seed video id (upsert). Empty
        results are still cached so a known-empty seed isn't re-fetched for a
        week."""
        if not video_id or not isinstance(results, list):
            return
        payload = json.dumps(results)
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute(
                    """
                    INSERT INTO related_mix_cache (video_id, results_json, last_updated)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(video_id) DO UPDATE SET
                        results_json=excluded.results_json,
                        last_updated=CURRENT_TIMESTAMP
                    """,
                    (video_id, payload),
                )
                conn.execute("COMMIT")
            except Exception as e:
                conn.execute("ROLLBACK")
                logger.warning("Error caching related mix: %s", e)

    # Note: Lyrics cache

    _LYRICS_NEGATIVE_TTL_SEC = 7 * 24 * 3600
    _LYRICS_RESOLVER_SOURCE = "lrclib:v4"

    def get_lyrics(self, track_id: str) -> Optional[Dict[str, Any]]:
        """Return the cached lyrics record for a track, or None if missing.
        A not-found record (no synced/plain, not instrumental) expires after
        7 days so the provider is retried; positive results never expire."""
        if not track_id:
            return None
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT synced, plain, instrumental, source, checked_at FROM track_lyrics WHERE track_id = ?",
                (track_id,),
            ).fetchone()
            if not row:
                return None
            record = dict(row)
            record["instrumental"] = bool(record["instrumental"])
            if not record["synced"] and not record["plain"] and not record["instrumental"]:
                # A negative result is only valid for the matcher that produced
                # it. Algorithm upgrades must retry immediately instead of
                # preserving stale misses for the full TTL.
                if record.get("source") != self._LYRICS_RESOLVER_SOURCE:
                    return None
                cutoff = int(self._LYRICS_NEGATIVE_TTL_SEC)
                fresh = conn.execute(
                    """
                    SELECT 1 FROM track_lyrics
                    WHERE track_id = ?
                      AND checked_at >= datetime('now', ? || ' seconds')
                    """,
                    (track_id, f"-{cutoff}"),
                ).fetchone()
                if not fresh:
                    return None
            return record

    def set_lyrics(
        self,
        track_id: str,
        *,
        synced: Optional[str] = None,
        plain: Optional[str] = None,
        instrumental: bool = False,
        source: Optional[str] = None,
    ) -> None:
        """Upsert the lyrics record for a track (also used for negative caching)."""
        if not track_id:
            return
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute(
                    """
                    INSERT INTO track_lyrics (track_id, synced, plain, instrumental, source, checked_at)
                    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(track_id) DO UPDATE SET
                        synced=excluded.synced,
                        plain=excluded.plain,
                        instrumental=excluded.instrumental,
                        source=excluded.source,
                        checked_at=CURRENT_TIMESTAMP
                    """,
                    (track_id, synced, plain, 1 if instrumental else 0, source),
                )
                conn.execute("COMMIT")
            except Exception as e:
                conn.execute("ROLLBACK")
                logger.warning("Error caching lyrics: %s", e)

    # Note: Agent token storage

    def _decode_scopes(self, raw: Any) -> list[str]:
        if isinstance(raw, list):
            return [str(item) for item in raw if str(item).strip()]
        if not raw:
            return []
        try:
            decoded = json.loads(raw)
        except Exception:
            return []
        if not isinstance(decoded, list):
            return []
        return [str(item) for item in decoded if str(item).strip()]

    def create_auth_token(
        self,
        token_id: str,
        token_hash: str,
        *,
        kind: str,
        scopes: list[str],
        name: Optional[str] = None,
        device_type: Optional[str] = None,
        expires_at: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        encoded_scopes = json.dumps(sorted({scope for scope in scopes if scope}))
        with self._get_connection() as conn:
            conn.execute("""
                INSERT INTO auth_tokens (id, name, token_hash, kind, device_type, scopes, expires_at, user_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                token_id,
                name or None,
                token_hash,
                kind,
                device_type or None,
                encoded_scopes,
                expires_at,
                user_id or None,
            ))
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT id, name, kind, device_type, scopes, user_id, created_at, last_used_at, expires_at, revoked_at
                FROM auth_tokens
                WHERE id = ?
            """, (token_id,)).fetchone()
            record = dict(row)
            record["scopes"] = self._decode_scopes(record.get("scopes"))
            return record

    def get_auth_token_by_hash(self, token_hash: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT id, name, token_hash, kind, device_type, scopes, user_id,
                       created_at, last_used_at, expires_at, revoked_at
                FROM auth_tokens
                WHERE token_hash = ?
                  AND revoked_at IS NULL
                  AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
            """, (token_hash,)).fetchone()
            if not row:
                return None
            record = dict(row)
            record["scopes"] = self._decode_scopes(record.get("scopes"))
            return record

    def touch_auth_token(self, token_id: str) -> None:
        with self._get_connection() as conn:
            conn.execute("""
                UPDATE auth_tokens
                SET last_used_at = CURRENT_TIMESTAMP
                WHERE id = ? AND revoked_at IS NULL
            """, (token_id,))

    def revoke_auth_token(self, token_id: str) -> None:
        with self._get_connection() as conn:
            conn.execute("""
                UPDATE auth_tokens
                SET revoked_at = CURRENT_TIMESTAMP
                WHERE id = ? AND revoked_at IS NULL
            """, (token_id,))

    def revoke_auth_tokens_by_kind(self, kind: str) -> None:
        with self._get_connection() as conn:
            conn.execute("""
                UPDATE auth_tokens
                SET revoked_at = CURRENT_TIMESTAMP
                WHERE kind = ? AND revoked_at IS NULL
            """, (kind,))

    def list_auth_tokens(
        self,
        *,
        kind: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        columns = (
            "id, name, kind, device_type, scopes, user_id, "
            "created_at, last_used_at, expires_at, revoked_at"
        )
        filters = []
        params: list[Any] = []
        if kind:
            filters.append("kind = ?")
            params.append(kind)
        if user_id:
            filters.append("user_id = ?")
            params.append(user_id)
        where = f"WHERE {' AND '.join(filters)}" if filters else ""
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                f"SELECT {columns} FROM auth_tokens {where} ORDER BY created_at DESC",
                tuple(params),
            ).fetchall()
            records = [dict(row) for row in rows]
            for record in records:
                record["scopes"] = self._decode_scopes(record.get("scopes"))
            return records

    def get_auth_token(self, token_id: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT id, name, kind, device_type, scopes, user_id,
                       created_at, last_used_at, expires_at, revoked_at
                FROM auth_tokens
                WHERE id = ?
            """, (token_id,)).fetchone()
            if not row:
                return None
            record = dict(row)
            record["scopes"] = self._decode_scopes(record.get("scopes"))
            return record

    # Note: Subsonic credentials (instance database)

    def set_subsonic_credential(self, user_id: str, secret_enc: str) -> Dict[str, Any]:
        """Store (or replace) one account's Subsonic credential."""
        with self._get_connection() as conn:
            conn.execute("""
                INSERT INTO subsonic_credentials (user_id, secret_enc)
                VALUES (?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    secret_enc=excluded.secret_enc,
                    created_at=CURRENT_TIMESTAMP,
                    last_used_at=NULL,
                    last_client=NULL
            """, (user_id, secret_enc))
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT user_id, created_at, last_used_at, last_client FROM subsonic_credentials WHERE user_id = ?",
                (user_id,),
            ).fetchone()
            return dict(row)

    def get_subsonic_credential(self, user_id: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT user_id, secret_enc, created_at, last_used_at, last_client
                FROM subsonic_credentials WHERE user_id = ?
            """, (user_id,)).fetchone()
            return dict(row) if row else None

    def touch_subsonic_credential(self, user_id: str, client: Optional[str] = None) -> None:
        with self._get_connection() as conn:
            conn.execute("""
                UPDATE subsonic_credentials
                SET last_used_at = CURRENT_TIMESTAMP,
                    last_client = COALESCE(?, last_client)
                WHERE user_id = ?
            """, (client or None, user_id))

    def delete_subsonic_credential(self, user_id: str) -> bool:
        with self._get_connection() as conn:
            cursor = conn.execute("DELETE FROM subsonic_credentials WHERE user_id = ?", (user_id,))
            return bool(cursor.rowcount)

    def _decode_pairing_record(self, record: Dict[str, Any]) -> Dict[str, Any]:
        record["requested_scopes"] = self._decode_scopes(record.get("requested_scopes"))
        record["granted_scopes"] = self._decode_scopes(record.get("granted_scopes"))
        record["auto_confirm"] = bool(record.get("auto_confirm"))
        record["display_active"] = bool(record.get("display_active"))
        return record

    def create_pairing_session(
        self,
        session_id: str,
        *,
        code: str,
        requested_scopes: list[str],
        granted_scopes: list[str],
        expires_at: str,
        auto_confirm: bool = False,
        display_active: bool = False,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("""
                INSERT INTO pairing_sessions (id, code, status, requested_scopes, granted_scopes, auto_confirm, display_active, expires_at, user_id)
                VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)
            """, (
                session_id,
                code,
                json.dumps(sorted({scope for scope in requested_scopes if scope})),
                json.dumps(sorted({scope for scope in granted_scopes if scope})),
                1 if auto_confirm else 0,
                1 if display_active else 0,
                expires_at,
                user_id,
            ))
            row = conn.execute("""
                SELECT *
                FROM pairing_sessions
                WHERE id = ?
            """, (session_id,)).fetchone()
            return self._decode_pairing_record(dict(row)) if row else {}

    def get_pairing_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT *
                FROM pairing_sessions
                WHERE id = ?
            """, (session_id,)).fetchone()
            if not row:
                return None
            return self._decode_pairing_record(dict(row))

    def get_pairing_session_by_code(self, code: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT *
                FROM pairing_sessions
                WHERE code = ?
                  AND expires_at > CURRENT_TIMESTAMP
            """, (code,)).fetchone()
            if not row:
                return None
            return self._decode_pairing_record(dict(row))

    def list_pairing_sessions(self, *, user_id: Optional[str] = None) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            if user_id:
                rows = conn.execute("""
                    SELECT *
                    FROM pairing_sessions
                    WHERE user_id = ?
                    ORDER BY created_at DESC
                """, (user_id,)).fetchall()
            else:
                rows = conn.execute("""
                    SELECT *
                    FROM pairing_sessions
                    ORDER BY created_at DESC
                """).fetchall()
            records = [dict(row) for row in rows]
            for record in records:
                self._decode_pairing_record(record)
            return records

    def claim_pairing_session(self, session_id: str, *, device_name: str, device_type: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("""
                UPDATE pairing_sessions
                SET status = 'claimed',
                    device_name = ?,
                    device_type = ?,
                    claimed_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                  AND status = 'pending'
                  AND expires_at > CURRENT_TIMESTAMP
            """, (device_name, device_type, session_id))
            if conn.total_changes == 0:
                return None
            row = conn.execute("""
                SELECT *
                FROM pairing_sessions
                WHERE id = ?
            """, (session_id,)).fetchone()
            return self._decode_pairing_record(dict(row)) if row else None

    def confirm_pairing_session(self, session_id: str, *, auth_token_id: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("""
                UPDATE pairing_sessions
                SET status = 'completed',
                    auth_token_id = ?,
                    owner_confirmed_at = CURRENT_TIMESTAMP,
                    completed_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                  AND status = 'claimed'
                  AND expires_at > CURRENT_TIMESTAMP
            """, (auth_token_id, session_id))
            if conn.total_changes == 0:
                return None
            row = conn.execute("""
                SELECT *
                FROM pairing_sessions
                WHERE id = ?
            """, (session_id,)).fetchone()
            return self._decode_pairing_record(dict(row)) if row else None

    def cancel_pairing_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("""
                UPDATE pairing_sessions
                SET status = 'cancelled',
                    display_active = 0,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                  AND status IN ('pending', 'claimed')
            """, (session_id,))
            if conn.total_changes == 0:
                return None
            row = conn.execute("""
                SELECT *
                FROM pairing_sessions
                WHERE id = ?
            """, (session_id,)).fetchone()
            return self._decode_pairing_record(dict(row)) if row else None

    def set_pairing_session_display_state(
        self,
        session_id: str,
        *,
        display_active: bool,
        auto_confirm: Optional[bool] = None,
    ) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            if auto_confirm is None:
                conn.execute("""
                    UPDATE pairing_sessions
                    SET display_active = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                      AND status IN ('pending', 'claimed')
                """, (1 if display_active else 0, session_id))
            else:
                conn.execute("""
                    UPDATE pairing_sessions
                    SET display_active = ?,
                        auto_confirm = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                      AND status IN ('pending', 'claimed')
                """, (1 if display_active else 0, 1 if auto_confirm else 0, session_id))
            if conn.total_changes == 0:
                return None
            row = conn.execute("""
                SELECT *
                FROM pairing_sessions
                WHERE id = ?
            """, (session_id,)).fetchone()
            return self._decode_pairing_record(dict(row)) if row else None

    def create_agent_token(self, token_id: str, token_hash: str, name: Optional[str] = None) -> Dict[str, Any]:
        with self._get_connection() as conn:
            conn.execute("""
                INSERT INTO agent_tokens (id, name, token_hash)
                VALUES (?, ?, ?)
            """, (token_id, name or None, token_hash))
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT id, name, created_at, last_used_at, revoked_at
                FROM agent_tokens
                WHERE id = ?
            """, (token_id,)).fetchone()
            return dict(row)

    def get_agent_token_by_hash(self, token_hash: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT id, name, token_hash, created_at, last_used_at, revoked_at
                FROM agent_tokens
                WHERE token_hash = ? AND revoked_at IS NULL
            """, (token_hash,)).fetchone()
            return dict(row) if row else None

    def touch_agent_token(self, token_id: str) -> None:
        with self._get_connection() as conn:
            conn.execute("""
                UPDATE agent_tokens
                SET last_used_at = CURRENT_TIMESTAMP
                WHERE id = ? AND revoked_at IS NULL
            """, (token_id,))

    # Note: Accounts (instance database only)

    _USER_COLUMNS = (
        "id, username, username_folded, display_name, avatar_color, password_hash, "
        "role, created_at, updated_at, disabled_at"
    )

    def create_user_row(
        self,
        user_id: str,
        *,
        username: str,
        display_name: Optional[str] = None,
        avatar_color: Optional[str] = None,
        password_hash: Optional[str] = None,
        role: str = "member",
    ) -> Dict[str, Any]:
        with self._get_connection() as conn:
            conn.execute("""
                INSERT INTO users (id, username, username_folded, display_name, avatar_color, password_hash, role)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                user_id,
                username,
                username.casefold(),
                display_name or username,
                avatar_color or None,
                password_hash or None,
                role,
            ))
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                f"SELECT {self._USER_COLUMNS} FROM users WHERE id = ?", (user_id,)
            ).fetchone()
            return dict(row)

    def get_user_row(self, user_id: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                f"SELECT {self._USER_COLUMNS} FROM users WHERE id = ?", (user_id,)
            ).fetchone()
            return dict(row) if row else None

    def get_user_row_by_username(self, username: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                f"SELECT {self._USER_COLUMNS} FROM users WHERE username_folded = ?",
                (str(username or "").casefold(),),
            ).fetchone()
            return dict(row) if row else None

    def list_user_rows(self, *, include_disabled: bool = True) -> List[Dict[str, Any]]:
        clause = "" if include_disabled else "WHERE disabled_at IS NULL"
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                f"SELECT {self._USER_COLUMNS} FROM users {clause} ORDER BY created_at ASC"
            ).fetchall()
            return [dict(row) for row in rows]

    def update_user_row(self, user_id: str, **fields: Any) -> Optional[Dict[str, Any]]:
        """Patch a user row. Only known columns are accepted."""
        allowed = {"username", "display_name", "avatar_color", "password_hash", "role", "disabled_at"}
        updates = {key: value for key, value in fields.items() if key in allowed}
        if not updates:
            return self.get_user_row(user_id)
        if "username" in updates:
            updates["username_folded"] = str(updates["username"]).casefold()
        assignments = ", ".join(f"{key} = ?" for key in updates)
        with self._get_connection() as conn:
            conn.execute(
                f"UPDATE users SET {assignments}, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (*updates.values(), user_id),
            )
        return self.get_user_row(user_id)

    def delete_user_row(self, user_id: str) -> bool:
        with self._get_connection() as conn:
            cursor = conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
            conn.execute("""
                UPDATE auth_tokens
                SET revoked_at = CURRENT_TIMESTAMP
                WHERE user_id = ? AND revoked_at IS NULL
            """, (user_id,))
            return cursor.rowcount > 0

    # Note: Invitations (instance database only)

    _INVITE_COLUMNS = (
        "id, display_name, role, created_by, created_at, expires_at, used_at, "
        "created_user_id, revoked_at"
    )

    def create_invite_row(
        self,
        invite_id: str,
        token_hash: str,
        *,
        expires_at: str,
        display_name: Optional[str] = None,
        role: str = "member",
        created_by: Optional[str] = None,
    ) -> Dict[str, Any]:
        with self._get_connection() as conn:
            conn.execute("""
                INSERT INTO invites (id, token_hash, display_name, role, created_by, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (invite_id, token_hash, display_name or None, role, created_by, expires_at))
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                f"SELECT {self._INVITE_COLUMNS} FROM invites WHERE id = ?", (invite_id,)
            ).fetchone()
            return dict(row)

    def get_invite_by_hash(self, token_hash: str) -> Optional[Dict[str, Any]]:
        """Return a still-redeemable invite, or ``None``."""
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(f"""
                SELECT {self._INVITE_COLUMNS}
                FROM invites
                WHERE token_hash = ?
                  AND used_at IS NULL
                  AND revoked_at IS NULL
                  AND expires_at > CURRENT_TIMESTAMP
            """, (token_hash,)).fetchone()
            return dict(row) if row else None

    def consume_invite(self, invite_id: str, *, created_user_id: str) -> bool:
        """Mark an invite used. Returns False if somebody got there first."""
        with self._get_connection() as conn:
            cursor = conn.execute("""
                UPDATE invites
                SET used_at = CURRENT_TIMESTAMP, created_user_id = ?
                WHERE id = ?
                  AND used_at IS NULL
                  AND revoked_at IS NULL
                  AND expires_at > CURRENT_TIMESTAMP
            """, (created_user_id, invite_id))
            return cursor.rowcount > 0

    def list_invite_rows(self) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                f"SELECT {self._INVITE_COLUMNS} FROM invites ORDER BY created_at DESC"
            ).fetchall()
            return [dict(row) for row in rows]

    def revoke_invite(self, invite_id: str) -> bool:
        with self._get_connection() as conn:
            cursor = conn.execute("""
                UPDATE invites
                SET revoked_at = CURRENT_TIMESTAMP
                WHERE id = ? AND revoked_at IS NULL AND used_at IS NULL
            """, (invite_id,))
            return cursor.rowcount > 0

    def count_users(self, *, include_disabled: bool = False) -> int:
        clause = "" if include_disabled else "WHERE disabled_at IS NULL"
        with self._get_connection() as conn:
            return int(conn.execute(f"SELECT COUNT(*) FROM users {clause}").fetchone()[0])


def _manager_for(db_path: Path) -> DatabaseManager:
    """A shared manager for ``db_path``, built once per path per process.

    These factories are called from ~57 sites, several of them on the path that
    resolves the caller of every request. Building a manager reconciles the
    schema, so handing back the same one turns that from per-call work into
    per-process work. Managers hold no per-request state; their connections are
    thread-local.
    """
    key = str(db_path)
    cached = _MANAGERS.get(key)
    if cached is not None:
        return cached
    with _MANAGERS_LOCK:
        cached = _MANAGERS.get(key)
        if cached is None:
            cached = DatabaseManager(key)
            _MANAGERS[key] = cached
        return cached


def reset_database_managers() -> None:
    """Drop every cached manager. Tests use this when they swap runtime dirs."""
    with _MANAGERS_LOCK:
        _MANAGERS.clear()
    _SCHEMA_READY.clear()


def instance_db() -> DatabaseManager:
    """Database holding accounts, credentials, pairing, and shared caches."""
    config_dir = get_config_dir()
    config_dir.mkdir(parents=True, exist_ok=True)
    return _manager_for(config_dir / INSTANCE_DB_FILENAME)


def user_db(user_id: Optional[str] = None) -> DatabaseManager:
    """Track index for ``user_id`` (default: the bound user)."""
    from shared.user_context import user_config_dir

    return _manager_for(user_config_dir(user_id) / USER_DB_FILENAME)
