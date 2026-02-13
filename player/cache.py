"""
Local caching system for the music player.
Implements an LRU (Least Recently Used) eviction policy and SQLite index.
"""

import sqlite3
import os
import shutil
import threading
from pathlib import Path
from datetime import datetime
from typing import Optional, Dict, Any, List
from shared.models import Track
from shared.constants import DEFAULT_CACHE_SIZE_GB

class CacheManager:
    """Manages local music file cache with LRU eviction."""
    
    def __init__(self, cache_dir: str = "~/.cache/soundsible/media", 
                 max_size_gb: int = DEFAULT_CACHE_SIZE_GB):
        self.cache_dir = Path(cache_dir).expanduser()
        self.max_size_bytes = max_size_gb * 1024 * 1024 * 1024
        self.db_path = self.cache_dir.parent / "cache_index.db"
        
        self.lock = threading.Lock()
        self._init_cache()
        self._init_db()
        
    def _init_cache(self):
        """Ensure cache directory exists."""
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        
    def _init_db(self):
        """Initialize SQLite database for cache tracking."""
        with self.lock:
             self.conn = sqlite3.connect(
                 self.db_path, 
                 check_same_thread=False,
                 timeout=20
             )
             self.conn.execute("PRAGMA journal_mode=WAL")
             self.conn.execute("PRAGMA synchronous=NORMAL")
             
             self.conn.execute("""
                 CREATE TABLE IF NOT EXISTS cache_entries (
                     track_id TEXT PRIMARY KEY,
                     file_path TEXT NOT NULL,
                     file_size INTEGER NOT NULL,
                     last_accessed TIMESTAMP NOT NULL,
                     access_count INTEGER DEFAULT 1
                 )
             """)
             self.conn.commit()

    def __del__(self):
        if hasattr(self, 'conn'):
            self.conn.close()
            
    def get_cached_path(self, track_id: str) -> Optional[str]:
        """
        Get path to cached file if exists. Updates access time.
        """
        with self.lock:
             try:
                cursor = self.conn.execute(
                    "SELECT file_path, file_size FROM cache_entries WHERE track_id = ?", 
                    (track_id,)
                )
                row = cursor.fetchone()
                
                if row:
                    file_path = row[0]
                    if os.path.exists(file_path):
                        # Update access stats
                        self.conn.execute("""
                            UPDATE cache_entries 
                            SET last_accessed = ?, access_count = access_count + 1 
                            WHERE track_id = ?
                        """, (datetime.utcnow(), track_id))
                        self.conn.commit()
                        return file_path
                    else:
                        # Orphaned entry cleanup
                        self.conn.execute("DELETE FROM cache_entries WHERE track_id = ?", (track_id,))
                        self.conn.commit()
             except sqlite3.OperationalError:
                 pass # Be resilient to locks
        return None

    def add_to_cache(self, track_id: str, source_path: str, move: bool = False) -> str:
        """
        Add a file to the cache. Evicts old files if needed.
        """
        file_size = os.path.getsize(source_path)
        
        # Ensure space
        self._ensure_space(file_size)
        
        target_name = f"{track_id}{Path(source_path).suffix}"
        target_path = self.cache_dir / target_name
        
        if move:
            shutil.move(source_path, target_path)
        else:
            shutil.copy2(source_path, target_path)
            
        # Update DB
        with self.lock:
             try:
                self.conn.execute("""
                    INSERT OR REPLACE INTO cache_entries 
                    (track_id, file_path, file_size, last_accessed, access_count)
                    VALUES (?, ?, ?, ?, 1)
                """, (track_id, str(target_path), file_size, datetime.utcnow()))
                self.conn.commit()
             except Exception:
                 pass
            
        return str(target_path)

    def prune_to_size(self, target_bytes: int):
        """Manually prune cache to a specific size (LRU)."""
        with self.lock:
            try:
                cursor = self.conn.execute("SELECT SUM(file_size) FROM cache_entries")
                result = cursor.fetchone()[0]
                current_size = result if result else 0
                
                if current_size <= target_bytes:
                    return

                # Get candidates (oldest first)
                cursor = self.conn.execute(
                    "SELECT track_id, file_path, file_size FROM cache_entries ORDER BY last_accessed ASC"
                )
                
                rows = cursor.fetchall()
                pruned_count = 0
                for row in rows:
                    track_id, file_path, size = row
                    
                    try:
                        if os.path.exists(file_path):
                            os.remove(file_path)
                    except OSError: pass
                    
                    self.conn.execute("DELETE FROM cache_entries WHERE track_id = ?", (track_id,))
                    
                    current_size -= size
                    pruned_count += 1
                    if current_size <= target_bytes:
                        break
                self.conn.commit()
                # print(f"Cache: Pruned {pruned_count} files to reach target size.")
            except Exception as e:
                pass

    def _ensure_space(self, new_bytes: int):
        """Free up space if needed using LRU policy."""
        self.prune_to_size(self.max_size_bytes - new_bytes)

    def get_current_usage(self) -> int:
        """Get total bytes used by cache."""
        with self.lock:
            try:
                cursor = self.conn.execute("SELECT SUM(file_size) FROM cache_entries")
                result = cursor.fetchone()[0]
                return result if result else 0
            except Exception as e:
                return 0

    def clear_cache(self):
        """Delete all cached files and reset DB."""
        try:
             shutil.rmtree(self.cache_dir)
        except Exception as e:
            pass
        self._init_cache()
        
        with self.lock:
             self.conn.execute("DELETE FROM cache_entries")
             self.conn.commit()

    def remove_track(self, track_id: str):
        """
        Remove a specific track from the cache (file and DB entry).
        """
        with self.lock:
             try:
                cursor = self.conn.execute(
                    "SELECT file_path FROM cache_entries WHERE track_id = ?",
                    (track_id,)
                )
                row = cursor.fetchone()
                
                if row:
                    file_path = row[0]
                    try:
                        if os.path.exists(file_path):
                            os.remove(file_path)
                    except OSError as e:
                        pass
                
                self.conn.execute("DELETE FROM cache_entries WHERE track_id = ?", (track_id,))
                self.conn.commit()
             except: pass
