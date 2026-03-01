"""
SQLite Database Manager for Soundsible.
Handles local metadata storage, rapid searching, and manifest synchronization.
"""

import sqlite3
import json
from pathlib import Path
from typing import List, Dict, Any, Optional
from shared.models import Track, LibraryMetadata
from shared.constants import DEFAULT_CONFIG_DIR

class DatabaseManager:
    def __init__(self, db_path: Optional[str] = None):
        if db_path is None:
            db_dir = Path(DEFAULT_CONFIG_DIR).expanduser()
            db_dir.mkdir(parents=True, exist_ok=True)
            self.db_path = db_dir / "library.db"
        else:
            self.db_path = Path(db_path)
            
        self._init_db()

    def _get_connection(self):
        conn = sqlite3.connect(self.db_path)
        # Enable WAL mode for high concurrency
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    def _init_db(self):
        """Initialize the database schema."""
        with self._get_connection() as conn:
            try:
                conn.execute("BEGIN TRANSACTION")
                
                # 1. Base Tables
                # Schema order must match the actual columns on disk to avoid confusion
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
                
                # 2. Search Index (FTS5)
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
                    
                    # Update Triggers
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
                    pass # FTS5 not available

                # 3. Schema Migrations (Ensure columns exist)
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

                # 4. YouTube Resolution Cache
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
                        PRIMARY KEY (artist, title)
                    )
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
                # Update version
                conn.execute("INSERT OR REPLACE INTO library_info (key, value) VALUES ('version', ?)", (str(metadata.version),))
                
                # 1. Get IDs of tracks we are about to sync
                incoming_ids = [t.id for t in metadata.tracks]
                
                # 2. Prune tracks that are no longer in the manifest
                if incoming_ids:
                    placeholders = ','.join(['?'] * len(incoming_ids))
                    conn.execute(f"DELETE FROM tracks WHERE id NOT IN ({placeholders})", incoming_ids)
                else:
                    conn.execute("DELETE FROM tracks")

                # 3. Batch update tracks
                for track in metadata.tracks:
                    # Column order MUST match the tuple below exactly
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
                            local_path=COALESCE(excluded.local_path, tracks.local_path),
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
                        track.is_local, track.local_path, track.musicbrainz_id, 
                        track.isrc, track.album_artist,
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
                # Try FTS5 first
                cursor = conn.execute("""
                    SELECT t.* FROM tracks t
                    JOIN tracks_fts f ON t.id = f.id
                    WHERE tracks_fts MATCH ?
                    ORDER BY rank
                """, (f"{query}*",))
                return [self._row_to_track(row) for row in cursor.fetchall()]
            except sqlite3.OperationalError:
                # Fallback to LIKE
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
            # Use MAX(album_artist) or fallback to artist if NO track in the album has album_artist
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
        # Map row to Track object
        data = dict(row)
        # Remove last_updated which isn't in Track model
        if 'last_updated' in data: del data['last_updated']
        return Track.from_dict(data)

    def get_stats(self) -> Dict[str, int]:
        with self._get_connection() as conn:
            total = conn.execute("SELECT COUNT(*) FROM tracks").fetchone()[0]
            local = conn.execute("SELECT COUNT(*) FROM tracks WHERE is_local = 1").fetchone()[0]
            cloud = conn.execute("SELECT COUNT(*) FROM tracks WHERE compressed = 1").fetchone()[0] # Approximation
            return {"tracks": total, "local": local, "cloud": cloud}

    def clear_all(self):
        """Wipe all data from the local database."""
        with self._get_connection() as conn:
            conn.execute("BEGIN TRANSACTION")
            try:
                conn.execute("DELETE FROM tracks")
                conn.execute("DELETE FROM library_info")
                # FTS5 table cleanup
                try:
                    conn.execute("DELETE FROM tracks_fts")
                except sqlite3.OperationalError:
                    pass
                conn.execute("COMMIT")
                conn.execute("VACUUM")
            except Exception as e:
                conn.execute("ROLLBACK")
                raise e

    # --- YouTube Resolution Cache ---

    def get_cached_resolution(self, artist: str, title: str) -> Optional[Dict[str, Any]]:
        """Fetch a cached YouTube resolution by artist and title."""
        if not artist or not title:
            return None
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("""
                SELECT youtube_id as id, duration, thumbnail, webpage_url, channel, artist, title
                FROM youtube_resolution_cache
                WHERE artist = ? AND title = ?
            """, (artist, title)).fetchone()
            return dict(row) if row else None

    def set_cached_resolution(self, artist: str, title: str, result: Dict[str, Any]):
        """Save a YouTube resolution to the cache."""
        if not artist or not title or not result or not result.get("id"):
            return
        with self._get_connection() as conn:
            conn.execute("BEGIN TRANSACTION")
            try:
                conn.execute("""
                    INSERT INTO youtube_resolution_cache 
                    (artist, title, youtube_id, duration, thumbnail, webpage_url, channel, last_updated)
                    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(artist, title) DO UPDATE SET
                    youtube_id=excluded.youtube_id,
                    duration=excluded.duration,
                    thumbnail=excluded.thumbnail,
                    webpage_url=excluded.webpage_url,
                    channel=excluded.channel,
                    last_updated=CURRENT_TIMESTAMP
                """, (
                    artist,
                    title,
                    result.get("id"),
                    result.get("duration") or 0,
                    result.get("thumbnail") or "",
                    result.get("webpage_url") or "",
                    result.get("channel") or ""
                ))
                conn.execute("COMMIT")
            except Exception as e:
                conn.execute("ROLLBACK")
                print(f"Error caching YouTube resolution: {e}")
