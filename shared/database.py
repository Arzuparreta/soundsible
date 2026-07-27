"""
SQLite Database Manager for Soundsible.
Handles local metadata storage, rapid searching, and manifest synchronization.
"""

import sqlite3
import json
import logging
from pathlib import Path
from typing import List, Dict, Any, Optional
from shared.models import Track, LibraryMetadata
from shared.runtime import get_config_dir, get_runtime_config

logger = logging.getLogger(__name__)

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
    "pairing_sessions",
    "youtube_resolution_cache",
    "related_mix_cache",
    "track_lyrics",
)

# Note: Migration definitions for schema evolution
_TRACKS_COLUMNS = {
    "youtube_id": "TEXT",
    "musicbrainz_id": "TEXT",
    "isrc": "TEXT",
    "album_artist": "TEXT",
    "cover_source": "TEXT",
    "metadata_modified_by_user": "BOOLEAN DEFAULT 0",
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


class DatabaseManager:
    def __init__(self, db_path: Optional[str] = None, *, user_id: Optional[str] = None):
        """Open a database. With no path this is the bound user's library index;
        use :func:`instance_db` for accounts, credentials, and shared caches."""
        runtime = get_runtime_config()
        self.portable = runtime.instance_dir is not None
        self.user_id = user_id
        if self.portable:
            from shared.instance_layout import InstanceLayout

            self.db_path = InstanceLayout.at(runtime.instance_dir).database
            if self.user_id is None and db_path is None:
                from shared.user_context import current_user_id

                self.user_id = current_user_id()
        elif db_path is None:
            from shared.user_context import user_config_dir

            self.db_path = user_config_dir() / USER_DB_FILENAME
        else:
            self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        self._init_db()

    def _get_connection(self):
        conn = sqlite3.connect(self.db_path)
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(f"PRAGMA synchronous={'FULL' if self.portable else 'NORMAL'}")
        return conn

    def _require_user_id(self) -> str:
        if self.user_id:
            return self.user_id
        from shared.user_context import require_user_id

        return require_user_id()

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
                is_local BOOLEAN,
                local_path TEXT,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                musicbrainz_id TEXT,
                isrc TEXT,
                album_artist TEXT,
                cover_source TEXT,
                metadata_modified_by_user BOOLEAN DEFAULT 0,
                youtube_id TEXT
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
        conn.execute("UPDATE tracks SET local_path = NULL WHERE local_path IS NOT NULL")

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
        """Lyrics cache keyed by track id. Kept separate from `tracks` because
        that table is rebuilt from the library.json manifest on every sync;
        lyrics are local-only and must survive re-syncs."""
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
                negative_count INTEGER NOT NULL DEFAULT 0,
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
                negative_delta INTEGER NOT NULL DEFAULT 0,
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
    def _create_portable_tables(conn):
        """Canonical per-user state inside a portable single database."""
        conn.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at INTEGER NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS library_documents (
                user_id TEXT PRIMARY KEY,
                version INTEGER NOT NULL,
                payload_json TEXT NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS user_tracks (
                user_id TEXT NOT NULL,
                id TEXT NOT NULL,
                title TEXT NOT NULL,
                artist TEXT NOT NULL,
                album TEXT,
                position INTEGER NOT NULL,
                payload_json TEXT NOT NULL,
                PRIMARY KEY (user_id, id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_user_tracks_album
            ON user_tracks (user_id, album, artist, position)
        """)
        try:
            conn.execute("""
                CREATE VIRTUAL TABLE IF NOT EXISTS user_tracks_fts USING fts5(
                    user_id UNINDEXED,
                    id UNINDEXED,
                    title,
                    artist,
                    album
                )
            """)
        except sqlite3.OperationalError:
            pass
        conn.execute("""
            CREATE TABLE IF NOT EXISTS user_state (
                user_id TEXT NOT NULL,
                state_key TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (user_id, state_key),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS instance_state (
                state_key TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS portable_discovery_signals (
                user_id TEXT NOT NULL,
                identity TEXT NOT NULL,
                media_type TEXT NOT NULL,
                title TEXT,
                artist TEXT,
                show_title TEXT,
                positive_weight REAL NOT NULL DEFAULT 0,
                negative_count INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (user_id, identity),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS portable_discovery_events (
                user_id TEXT NOT NULL,
                id TEXT NOT NULL,
                event TEXT NOT NULL,
                identity TEXT NOT NULL,
                media_type TEXT NOT NULL,
                positive_delta REAL NOT NULL DEFAULT 0,
                negative_delta INTEGER NOT NULL DEFAULT 0,
                payload_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                undone_at INTEGER,
                PRIMARY KEY (user_id, id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_portable_discovery_events_created
            ON portable_discovery_events (user_id, created_at DESC)
        """)

    def _init_db(self):
        """Initialize the database schema.

        Both files get the full schema. The unused tables cost nothing, and it
        means a pre-multiuser `library.db` still answers auth queries while its
        instance rows are being migrated into `instance.db`.
        """
        with self._get_connection() as conn:
            try:
                conn.execute("BEGIN TRANSACTION")
                self._create_youtube_cache_table(conn)
                self._create_related_mix_cache_table(conn)
                self._create_users_table(conn)
                self._create_invites_table(conn)
                self._create_auth_tables(conn)
                self._create_pairing_table(conn)
                self._create_lyrics_table(conn)
                if self.portable:
                    self._create_portable_tables(conn)
                    import time

                    conn.execute(
                        """
                        INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
                        VALUES (1, 'portable_instance_v1', ?)
                        """,
                        (int(time.time()),),
                    )
                    conn.execute("PRAGMA user_version=1")
                else:
                    self._create_tracks_table(conn)
                    self._create_library_info_table(conn)
                    self._create_fts5_triggers(conn)
                    self._migrate_tracks_columns(conn)
                    self._create_discovery_tables(conn)
                    self._create_performance_indexes(conn)
                conn.execute("COMMIT")
            except Exception as e:
                conn.execute("ROLLBACK")
                raise e

    def sync_from_metadata(self, metadata: LibraryMetadata):
        """
        Merge a LibraryMetadata object (from library.json) into the local DB.
        Uses an atomic transaction for safety.
        """
        if self.portable:
            self._sync_portable_metadata(metadata)
            return
        with self._get_connection() as conn:
            conn.execute("BEGIN TRANSACTION")
            try:
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
                            is_local, local_path, musicbrainz_id, isrc, album_artist,
                            cover_source, metadata_modified_by_user, youtube_id
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET
                            title=excluded.title,
                            artist=excluded.artist,
                            album=excluded.album,
                            duration=excluded.duration,
                            file_hash=excluded.file_hash,
                            cover_art_key=excluded.cover_art_key,
                            year=excluded.year,
                            genre=excluded.genre,
                            track_number=excluded.track_number,
                            is_local=CASE WHEN excluded.is_local THEN 1 ELSE tracks.is_local END,
                            local_path=excluded.local_path,
                            musicbrainz_id=COALESCE(excluded.musicbrainz_id, tracks.musicbrainz_id),
                            isrc=COALESCE(excluded.isrc, tracks.isrc),
                            album_artist=excluded.album_artist,
                            cover_source=COALESCE(excluded.cover_source, tracks.cover_source),
                            metadata_modified_by_user=CASE WHEN excluded.metadata_modified_by_user THEN 1 ELSE tracks.metadata_modified_by_user END,
                            youtube_id=COALESCE(excluded.youtube_id, tracks.youtube_id)
                    """, (
                        track.id, track.title, track.artist, track.album,
                        track.duration, track.file_hash, track.original_filename, 
                        track.compressed, track.file_size, track.bitrate, track.format, 
                        track.cover_art_key, track.year, track.genre, track.track_number, 
                        track.is_local, None,
                        track.musicbrainz_id, track.isrc, track.album_artist,
                        track.cover_source, track.metadata_modified_by_user, track.youtube_id
                    ))
                conn.execute("COMMIT")
            except Exception as e:
                conn.execute("ROLLBACK")
                raise e

    def _sync_portable_metadata(self, metadata: LibraryMetadata) -> None:
        import time

        user_id = self._require_user_id()
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute(
                    """
                    INSERT INTO library_documents (
                        user_id, version, payload_json, revision, updated_at
                    ) VALUES (?, ?, ?, 1, ?)
                    ON CONFLICT(user_id) DO UPDATE SET
                        version=excluded.version,
                        payload_json=excluded.payload_json,
                        revision=library_documents.revision + 1,
                        updated_at=excluded.updated_at
                    """,
                    (user_id, int(metadata.version), metadata.to_json(), int(time.time())),
                )
                conn.execute("DELETE FROM user_tracks WHERE user_id = ?", (user_id,))
                try:
                    conn.execute("DELETE FROM user_tracks_fts WHERE user_id = ?", (user_id,))
                except sqlite3.OperationalError:
                    pass
                rows = []
                fts_rows = []
                for position, track in enumerate(metadata.tracks):
                    track_payload = track.to_dict()
                    track_payload.pop("local_path", None)
                    rows.append(
                        (
                            user_id,
                            track.id,
                            track.title,
                            track.artist,
                            track.album,
                            position,
                            json.dumps(track_payload, ensure_ascii=False, sort_keys=True),
                        )
                    )
                    fts_rows.append((user_id, track.id, track.title, track.artist, track.album))
                conn.executemany(
                    """
                    INSERT INTO user_tracks (
                        user_id, id, title, artist, album, position, payload_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    rows,
                )
                if fts_rows:
                    try:
                        conn.executemany(
                            """
                            INSERT INTO user_tracks_fts (user_id, id, title, artist, album)
                            VALUES (?, ?, ?, ?, ?)
                            """,
                            fts_rows,
                        )
                    except sqlite3.OperationalError:
                        pass
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise

    def load_metadata(self) -> Optional[LibraryMetadata]:
        if not self.portable:
            return None
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT payload_json FROM library_documents WHERE user_id = ?",
                (self._require_user_id(),),
            ).fetchone()
        return LibraryMetadata.from_json(row[0]) if row else None

    def get_state(self, state_key: str, default: Any = None) -> Any:
        if not self.portable:
            return default
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT payload_json FROM user_state WHERE user_id = ? AND state_key = ?",
                (self._require_user_id(), state_key),
            ).fetchone()
        if not row:
            return default
        try:
            return json.loads(row[0])
        except (TypeError, json.JSONDecodeError):
            return default

    def set_state(self, state_key: str, payload: Any) -> None:
        if not self.portable:
            raise RuntimeError("State documents require a portable instance")
        import time

        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO user_state (user_id, state_key, payload_json, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id, state_key) DO UPDATE SET
                    payload_json=excluded.payload_json,
                    updated_at=excluded.updated_at
                """,
                (
                    self._require_user_id(),
                    state_key,
                    json.dumps(payload, ensure_ascii=False),
                    int(time.time()),
                ),
            )

    def delete_state(self, state_key: str) -> None:
        if not self.portable:
            return
        with self._get_connection() as conn:
            conn.execute(
                "DELETE FROM user_state WHERE user_id = ? AND state_key = ?",
                (self._require_user_id(), state_key),
            )

    def get_instance_state(self, state_key: str, default: Any = None) -> Any:
        if not self.portable:
            return default
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT payload_json FROM instance_state WHERE state_key = ?",
                (state_key,),
            ).fetchone()
        if not row:
            return default
        try:
            return json.loads(row[0])
        except (TypeError, json.JSONDecodeError):
            return default

    def set_instance_state(self, state_key: str, payload: Any) -> None:
        if not self.portable:
            raise RuntimeError("Instance state requires a portable instance")
        import time

        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO instance_state (state_key, payload_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(state_key) DO UPDATE SET
                    payload_json=excluded.payload_json,
                    updated_at=excluded.updated_at
                """,
                (state_key, json.dumps(payload, ensure_ascii=False), int(time.time())),
            )

    def get_all_tracks(self) -> List[Track]:
        """Fetch all tracks as Track objects."""
        if self.portable:
            with self._get_connection() as conn:
                rows = conn.execute(
                    "SELECT payload_json FROM user_tracks WHERE user_id = ? ORDER BY position",
                    (self._require_user_id(),),
                ).fetchall()
            return [Track.from_dict(json.loads(row[0])) for row in rows]
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute("SELECT * FROM tracks ORDER BY artist, album, track_number")
            return [self._row_to_track(row) for row in cursor.fetchall()]

    def record_discovery_signal(
        self,
        *,
        event_id: str,
        event: str,
        identity: str,
        media_type: str,
        positive_delta: float,
        negative_delta: int,
        payload: Dict[str, Any],
        created_at: int,
    ) -> None:
        """Atomically append an event and fold it into the current profile."""
        if self.portable:
            user_id = self._require_user_id()
            with self._get_connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
                conn.execute(
                    """
                    INSERT INTO portable_discovery_events (
                        user_id, id, event, identity, media_type, positive_delta,
                        negative_delta, payload_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        user_id,
                        event_id,
                        event,
                        identity,
                        media_type,
                        float(positive_delta),
                        int(negative_delta),
                        json.dumps(payload, sort_keys=True, ensure_ascii=False),
                        int(created_at),
                    ),
                )
                conn.execute(
                    """
                    INSERT INTO portable_discovery_signals (
                        user_id, identity, media_type, title, artist, show_title,
                        positive_weight, negative_count, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(user_id, identity) DO UPDATE SET
                        media_type=excluded.media_type,
                        title=COALESCE(NULLIF(excluded.title, ''), portable_discovery_signals.title),
                        artist=COALESCE(NULLIF(excluded.artist, ''), portable_discovery_signals.artist),
                        show_title=COALESCE(NULLIF(excluded.show_title, ''), portable_discovery_signals.show_title),
                        positive_weight=MAX(0, portable_discovery_signals.positive_weight + excluded.positive_weight),
                        negative_count=MAX(0, portable_discovery_signals.negative_count + excluded.negative_count),
                        updated_at=excluded.updated_at
                    """,
                    (
                        user_id,
                        identity,
                        media_type,
                        str(payload.get("title") or "")[:220],
                        str(payload.get("artist") or "")[:220],
                        str(payload.get("podcast_show_title") or "")[:220],
                        float(positive_delta),
                        int(negative_delta),
                        int(created_at),
                    ),
                )
                conn.execute("COMMIT")
            return
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
                    int(negative_delta),
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
                    int(negative_delta),
                    int(created_at),
                ),
            )
            conn.execute("COMMIT")

    def undo_discovery_signal(self, event_id: str, undone_at: int) -> bool:
        """Undo one event exactly once and reverse its aggregate deltas."""
        if self.portable:
            user_id = self._require_user_id()
            with self._get_connection() as conn:
                conn.row_factory = sqlite3.Row
                conn.execute("BEGIN IMMEDIATE")
                row = conn.execute(
                    """
                    SELECT identity, positive_delta, negative_delta
                    FROM portable_discovery_events
                    WHERE user_id = ? AND id = ? AND undone_at IS NULL
                    """,
                    (user_id, event_id),
                ).fetchone()
                if row is None:
                    conn.execute("ROLLBACK")
                    return False
                conn.execute(
                    """
                    UPDATE portable_discovery_events SET undone_at = ?
                    WHERE user_id = ? AND id = ?
                    """,
                    (int(undone_at), user_id, event_id),
                )
                conn.execute(
                    """
                    UPDATE portable_discovery_signals
                    SET positive_weight=MAX(0, positive_weight - ?),
                        negative_count=MAX(0, negative_count - ?),
                        updated_at=?
                    WHERE user_id=? AND identity=?
                    """,
                    (
                        float(row["positive_delta"]),
                        int(row["negative_delta"]),
                        int(undone_at),
                        user_id,
                        str(row["identity"]),
                    ),
                )
                conn.execute("COMMIT")
                return True
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
                    int(row["negative_delta"]),
                    int(undone_at),
                    str(row["identity"]),
                ),
            )
            conn.execute("COMMIT")
            return True

    def get_discovery_signals(self) -> Dict[str, Dict[str, Any]]:
        if self.portable:
            with self._get_connection() as conn:
                conn.row_factory = sqlite3.Row
                rows = conn.execute(
                    "SELECT * FROM portable_discovery_signals WHERE user_id = ?",
                    (self._require_user_id(),),
                ).fetchall()
                return {str(row["identity"]): dict(row) for row in rows}
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute("SELECT * FROM discovery_signals").fetchall()
            return {str(row["identity"]): dict(row) for row in rows}

    def clear_discovery_signals(self) -> None:
        if self.portable:
            user_id = self._require_user_id()
            with self._get_connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
                conn.execute("DELETE FROM portable_discovery_events WHERE user_id = ?", (user_id,))
                conn.execute("DELETE FROM portable_discovery_signals WHERE user_id = ?", (user_id,))
                conn.execute("COMMIT")
            return
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM discovery_events")
            conn.execute("DELETE FROM discovery_signals")
            conn.execute("COMMIT")

    def search_tracks(self, query: str) -> List[Track]:
        """Fast search tracks using FTS5 or LIKE."""
        if not query:
            return self.get_all_tracks()

        if self.portable:
            user_id = self._require_user_id()
            with self._get_connection() as conn:
                try:
                    ids = [
                        row[0]
                        for row in conn.execute(
                            """
                            SELECT id FROM user_tracks_fts
                            WHERE user_tracks_fts MATCH ? AND user_id = ?
                            LIMIT 100
                            """,
                            (f"{query}*", user_id),
                        ).fetchall()
                    ]
                except sqlite3.OperationalError:
                    ids = []
                if ids:
                    placeholders = ",".join("?" for _ in ids)
                    rows = conn.execute(
                        f"""
                        SELECT payload_json FROM user_tracks
                        WHERE user_id = ? AND id IN ({placeholders})
                        ORDER BY position
                        """,
                        (user_id, *ids),
                    ).fetchall()
                else:
                    pattern = f"%{query}%"
                    rows = conn.execute(
                        """
                        SELECT payload_json FROM user_tracks
                        WHERE user_id = ?
                          AND (title LIKE ? OR artist LIKE ? OR album LIKE ?)
                        ORDER BY position
                        LIMIT 100
                        """,
                        (user_id, pattern, pattern, pattern),
                    ).fetchall()
            return [Track.from_dict(json.loads(row[0])) for row in rows]

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
                return [self._row_to_track(row) for row in cursor.fetchall()]
            except sqlite3.OperationalError:
                # Note: Fallback to LIKE
                cursor = conn.execute("""
                    SELECT * FROM tracks 
                    WHERE title LIKE ? OR artist LIKE ? OR album LIKE ?
                    ORDER BY artist, title
                """, (f"%{query}%", f"%{query}%", f"%{query}%"))
                return [self._row_to_track(row) for row in cursor.fetchall()]

    def get_track(self, track_id: str) -> Optional[Track]:
        if self.portable:
            with self._get_connection() as conn:
                row = conn.execute(
                    "SELECT payload_json FROM user_tracks WHERE user_id = ? AND id = ?",
                    (self._require_user_id(), track_id),
                ).fetchone()
            return Track.from_dict(json.loads(row[0])) if row else None
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
            return self._row_to_track(row) if row else None

    def get_albums(self) -> List[Dict[str, Any]]:
        """
        Fetch unique albums with metadata.
        Groups strictly by album name to prevent splitting when multiple artists are involved.
        Picks the most representative artist (Album Artist if available).
        """
        if self.portable:
            grouped: Dict[str, Dict[str, Any]] = {}
            for track in self.get_all_tracks():
                album = track.album or ""
                row = grouped.setdefault(
                    album,
                    {
                        "album": album,
                        "artist": track.album_artist or track.artist,
                        "first_track_id": track.id,
                        "track_count": 0,
                        "year": track.year,
                    },
                )
                row["track_count"] += 1
            return sorted(grouped.values(), key=lambda row: (row["artist"], row["album"]))
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            # Note: Use MAX(album_artist) or fallback to artist if NO track in the album has album_artist
            cursor = conn.execute("""
                SELECT 
                    album, 
                    COALESCE(MAX(album_artist), artist) as artist, 
                    MIN(id) as first_track_id, 
                    COUNT(*) as track_count, 
                    year
                FROM tracks 
                GROUP BY album
                ORDER BY artist, album
            """)
            return [dict(row) for row in cursor.fetchall()]

    def get_tracks_by_album(self, album_name: str, artist_name: str = None) -> List[Track]:
        """
        Fetch all tracks for a specific album.
        If artist_name is provided, it's used as a secondary filter for identically named albums.
        """
        if self.portable:
            tracks = [
                track
                for track in self.get_all_tracks()
                if track.album == album_name
                and (
                    artist_name is None
                    or track.album_artist == artist_name
                    or track.artist == artist_name
                )
            ]
            return sorted(tracks, key=lambda track: track.track_number or 0)
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
            return [self._row_to_track(row) for row in cursor.fetchall()]

    def _row_to_track(self, row: sqlite3.Row) -> Track:
        # Note: Map row to track object; ignore stored local_path (resolve at read from output_dir).
        data = dict(row)
        if "last_updated" in data:
            del data["last_updated"]
        data["local_path"] = None
        return Track.from_dict(data)

    def get_stats(self) -> Dict[str, int]:
        if self.portable:
            tracks = self.get_all_tracks()
            return {
                "tracks": len(tracks),
                "local": sum(1 for track in tracks if track.is_local),
                "cloud": sum(1 for track in tracks if track.compressed),
            }
        with self._get_connection() as conn:
            total = conn.execute("SELECT COUNT(*) FROM tracks").fetchone()[0]
            local = conn.execute("SELECT COUNT(*) FROM tracks WHERE is_local = 1").fetchone()[0]
            cloud = conn.execute("SELECT COUNT(*) FROM tracks WHERE compressed = 1").fetchone()[0] # Note: Approximation
            return {"tracks": total, "local": local, "cloud": cloud}

    def clear_all(self):
        """Wipe all data from the local database."""
        if self.portable:
            user_id = self._require_user_id()
            with self._get_connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
                conn.execute("DELETE FROM user_tracks WHERE user_id = ?", (user_id,))
                conn.execute("DELETE FROM library_documents WHERE user_id = ?", (user_id,))
                try:
                    conn.execute("DELETE FROM user_tracks_fts WHERE user_id = ?", (user_id,))
                except sqlite3.OperationalError:
                    pass
                conn.execute("COMMIT")
            return
        with self._get_connection() as conn:
            conn.execute("BEGIN TRANSACTION")
            try:
                conn.execute("DELETE FROM tracks")
                conn.execute("DELETE FROM library_info")
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
            conn.execute("BEGIN TRANSACTION")
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

    def set_related_mix(self, video_id: str, results: list) -> None:
        """Persist related-mix results for a seed video id (upsert). Empty
        results are still cached so a known-empty seed isn't re-fetched for a
        week."""
        if not video_id or not isinstance(results, list):
            return
        payload = json.dumps(results)
        with self._get_connection() as conn:
            conn.execute("BEGIN TRANSACTION")
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
    _LYRICS_RESOLVER_SOURCE = "lrclib:v2"

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
            conn.execute("BEGIN TRANSACTION")
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


def instance_db() -> DatabaseManager:
    """Database holding accounts, credentials, pairing, and shared caches."""
    runtime = get_runtime_config()
    if runtime.instance_dir is not None:
        from shared.instance_layout import InstanceLayout

        return DatabaseManager(str(InstanceLayout.at(runtime.instance_dir).database))
    config_dir = get_config_dir()
    config_dir.mkdir(parents=True, exist_ok=True)
    return DatabaseManager(str(config_dir / INSTANCE_DB_FILENAME))


def user_db(user_id: Optional[str] = None) -> DatabaseManager:
    """Track index for ``user_id`` (default: the bound user)."""
    runtime = get_runtime_config()
    if runtime.instance_dir is not None:
        from shared.instance_layout import InstanceLayout
        from shared.user_context import current_user_id

        return DatabaseManager(
            str(InstanceLayout.at(runtime.instance_dir).database),
            user_id=user_id or current_user_id(),
        )
    from shared.user_context import user_config_dir

    return DatabaseManager(str(user_config_dir(user_id) / USER_DB_FILENAME))
