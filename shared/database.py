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
from shared.runtime import get_config_dir

logger = logging.getLogger(__name__)

class DatabaseManager:
    def __init__(self, db_path: Optional[str] = None):
        if db_path is None:
            db_dir = get_config_dir()
            db_dir.mkdir(parents=True, exist_ok=True)
            self.db_path = db_dir / "library.db"
        else:
            self.db_path = Path(db_path)
            
        self._init_db()

    def _get_connection(self):
        conn = sqlite3.connect(self.db_path)
        # Note: Enable WAL mode for high concurrency
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    def _init_db(self):
        """Initialize the database schema."""
        with self._get_connection() as conn:
            try:
                conn.execute("BEGIN TRANSACTION")
                
                # Note: 1. Base tables
                # Note: Schema order must match the actual columns on disk to avoid confusion
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
                        metadata_modified_by_user BOOLEAN DEFAULT 0
                    )
                """)
                
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS library_info (
                        key TEXT PRIMARY KEY,
                        value TEXT
                    )
                """)
                
                # Note: 2. Search index (FTS5)
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
                    
                    # Note: Update triggers
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
                    pass # Note: FTS5 not available

                # Note: 3. Schema migrations (ensure columns exist)
                cursor = conn.execute("PRAGMA table_info(tracks)")
                columns = [row[1] for row in cursor.fetchall()]
                if 'musicbrainz_id' not in columns:
                    conn.execute("ALTER TABLE tracks ADD COLUMN musicbrainz_id TEXT")
                if 'isrc' not in columns:
                    conn.execute("ALTER TABLE tracks ADD COLUMN isrc TEXT")
                if 'album_artist' not in columns:
                    conn.execute("ALTER TABLE tracks ADD COLUMN album_artist TEXT")
                if 'cover_source' not in columns:
                    conn.execute("ALTER TABLE tracks ADD COLUMN cover_source TEXT")
                if 'metadata_modified_by_user' not in columns:
                    conn.execute("ALTER TABLE tracks ADD COLUMN metadata_modified_by_user BOOLEAN DEFAULT 0")

                # Note: 3B. clear stored local_path (path is resolved at read from output_dir)
                conn.execute("UPDATE tracks SET local_path = NULL WHERE local_path IS NOT NULL")

                # Note: 4. Youtube resolution cache
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
                for col, defn in [
                    ("confidence", "REAL"),
                    ("confidence_reason", "TEXT"),
                    ("candidates_json", "TEXT"),
                    ("failure_state", "TEXT"),
                    ("verified_at", "TIMESTAMP"),
                ]:
                    if col not in yt_cols:
                        conn.execute(f"ALTER TABLE youtube_resolution_cache ADD COLUMN {col} {defn}")

                # Note: Agent API tokens are random bearer tokens; only hashes are stored.
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
                if "auto_confirm" not in pairing_columns:
                    conn.execute("ALTER TABLE pairing_sessions ADD COLUMN auto_confirm INTEGER NOT NULL DEFAULT 0")
                if "display_active" not in pairing_columns:
                    conn.execute("ALTER TABLE pairing_sessions ADD COLUMN display_active INTEGER NOT NULL DEFAULT 0")
                
                # Note: 5. Performance indexes for common access patterns
                # - get_all_tracks orders by artist, album, track_number
                # - get_albums groups by album and reports an artist
                # - get_tracks_by_album filters by album/artist and orders by track_number
                conn.execute("""
                    CREATE INDEX IF NOT EXISTS idx_tracks_album_sort 
                    ON tracks (album, album_artist, artist, track_number)
                """)
                
                conn.execute("COMMIT")
            except Exception as e:
                conn.execute("ROLLBACK")
                raise e

    def sync_from_metadata(self, metadata: LibraryMetadata):
        """
        Merge a LibraryMetadata object (from library.json) into the local DB.
        Uses an atomic transaction for safety.
        """
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
                            cover_source, metadata_modified_by_user
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                            metadata_modified_by_user=CASE WHEN excluded.metadata_modified_by_user THEN 1 ELSE tracks.metadata_modified_by_user END
                    """, (
                        track.id, track.title, track.artist, track.album,
                        track.duration, track.file_hash, track.original_filename, 
                        track.compressed, track.file_size, track.bitrate, track.format, 
                        track.cover_art_key, track.year, track.genre, track.track_number, 
                        track.is_local, None,
                        track.musicbrainz_id, track.isrc, track.album_artist,
                        track.cover_source, track.metadata_modified_by_user
                    ))
                conn.execute("COMMIT")
            except Exception as e:
                conn.execute("ROLLBACK")
                raise e

    def get_all_tracks(self) -> List[Track]:
        """Fetch all tracks as Track objects."""
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute("SELECT * FROM tracks ORDER BY artist, album, track_number")
            return [self._row_to_track(row) for row in cursor.fetchall()]

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
        with self._get_connection() as conn:
            total = conn.execute("SELECT COUNT(*) FROM tracks").fetchone()[0]
            local = conn.execute("SELECT COUNT(*) FROM tracks WHERE is_local = 1").fetchone()[0]
            cloud = conn.execute("SELECT COUNT(*) FROM tracks WHERE compressed = 1").fetchone()[0] # Note: Approximation
            return {"tracks": total, "local": local, "cloud": cloud}

    def clear_all(self):
        """Wipe all data from the local database."""
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
    ) -> Dict[str, Any]:
        encoded_scopes = json.dumps(sorted({scope for scope in scopes if scope}))
        with self._get_connection() as conn:
            conn.execute("""
                INSERT INTO auth_tokens (id, name, token_hash, kind, device_type, scopes, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (token_id, name or None, token_hash, kind, device_type or None, encoded_scopes, expires_at))
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT id, name, kind, device_type, scopes, created_at, last_used_at, expires_at, revoked_at
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
                SELECT id, name, token_hash, kind, device_type, scopes, created_at, last_used_at, expires_at, revoked_at
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

    def list_auth_tokens(self, *, kind: Optional[str] = None) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            if kind:
                rows = conn.execute("""
                    SELECT id, name, kind, device_type, scopes, created_at, last_used_at, expires_at, revoked_at
                    FROM auth_tokens
                    WHERE kind = ?
                    ORDER BY created_at DESC
                """, (kind,)).fetchall()
            else:
                rows = conn.execute("""
                    SELECT id, name, kind, device_type, scopes, created_at, last_used_at, expires_at, revoked_at
                    FROM auth_tokens
                    ORDER BY created_at DESC
                """).fetchall()
            records = [dict(row) for row in rows]
            for record in records:
                record["scopes"] = self._decode_scopes(record.get("scopes"))
            return records

    def get_auth_token(self, token_id: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT id, name, kind, device_type, scopes, created_at, last_used_at, expires_at, revoked_at
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
    ) -> Dict[str, Any]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("""
                INSERT INTO pairing_sessions (id, code, status, requested_scopes, granted_scopes, auto_confirm, display_active, expires_at)
                VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
            """, (
                session_id,
                code,
                json.dumps(sorted({scope for scope in requested_scopes if scope})),
                json.dumps(sorted({scope for scope in granted_scopes if scope})),
                1 if auto_confirm else 0,
                1 if display_active else 0,
                expires_at,
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

    def list_pairing_sessions(self) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
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
