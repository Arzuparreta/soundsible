import concurrent.futures
import queue
import re
import os
import threading
import time
import gi
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GLib, GdkPixbuf

from shared.constants import DEFAULT_CACHE_DIR
from setup_tool.metadata import search_itunes, download_image
from setup_tool.audio import AudioProcessor
import tempfile

class CoverFetchManager:
    _instance = None
    
    @classmethod
    def get_instance(cls):
        if not cls._instance:
            cls._instance = cls()
        return cls._instance

    def __init__(self):
        self.callbacks = {} # map track_id -> list of callbacks(path)
        self.lock = threading.Lock()
        
        self.covers_dir = os.path.join(os.path.expanduser(DEFAULT_CACHE_DIR), "covers")
        os.makedirs(self.covers_dir, exist_ok=True)
        
        # Bounded Thread Pool
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="CoverWorker")
        self.submitted_tracks = set() # Track IDs currently in pool

    def get_cached_path(self, track_id):
        path = os.path.join(self.covers_dir, f"{track_id}.jpg")
        if os.path.exists(path):
            return path
        return None

    def request_cover(self, track, embedded_cache_info=None, callback=None):
        """
        Request a cover for a track.
        Callback receives: (pixbuf)
        """
        # 1. Check Smart Cache (Fastest) - Check existence, if yes, decode in BACKGROUND
        path = self.get_cached_path(track.id)
        if path:
             # Even if cached, decode in background to save UI thread
             # We can use the executor for this too
             if callback:
                 with self.lock:
                    if track.id not in self.callbacks:
                        self.callbacks[track.id] = []
                    self.callbacks[track.id].append(callback)
                 
                 self.executor.submit(self._load_and_notify, track.id, path)
             return

        # 2. Register callback
        if callback:
            with self.lock:
                if track.id not in self.callbacks:
                    self.callbacks[track.id] = []
                self.callbacks[track.id].append(callback)

        # 3. Submit to pool if not already running
        with self.lock:
            if track.id not in self.submitted_tracks:
                self.submitted_tracks.add(track.id)
                self.executor.submit(self._process_track, track, embedded_cache_info)

    def _process_track(self, track, embedded_path):
        try:
            dest_path = os.path.join(self.covers_dir, f"{track.id}.jpg")
            
            # Double check if appeared while waiting
            if os.path.exists(dest_path):
                self._notify_success(track.id, dest_path)
                return

            found = False

            # A. Try Embedded Art (Medium)
            if embedded_path and os.path.exists(embedded_path):
                try:
                    cover_data = AudioProcessor.extract_cover_art(embedded_path)
                    if cover_data:
                        with open(dest_path, 'wb') as f:
                            f.write(cover_data)
                        found = True
                except Exception:
                    pass
            
            # B. Network Fetch (Slow)
            if not found:
                 # Rate limit slightly to avoid spamming iTunes if pool is churning fast
                 time.sleep(0.2) 
                 found = self._fetch_online(track, dest_path)

            if found:
                self._load_and_notify(track.id, dest_path)
            elif os.path.exists(dest_path):
                 # Fallback if found earlier but logic skipped
                 self._load_and_notify(track.id, dest_path)

        except Exception as e:
            print(f"Error processing cover for {track.title}: {e}")
        finally:
            with self.lock:
                self.submitted_tracks.discard(track.id)

    def _load_and_notify(self, track_id, path):
        try:
            # Decode in worker thread
            pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 32, 32, True)
            self._notify_success(track_id, pixbuf)
        except Exception as e:
            print(f"Failed to decode cached cover {path}: {e}")

    def _notify_success(self, track_id, pixbuf):
        with self.lock:
            cbs = self.callbacks.pop(track_id, [])
            
        for cb in cbs:
            GLib.idle_add(cb, pixbuf)

    def _fetch_online(self, track, dest_path):
        try:
            # Search strategies
            queries = [f"{track.artist} {track.title}"]
            clean_query = f"{track.artist} {track.title}"
            clean_query = re.sub(r'(?i)original soundtrack|ost', '', clean_query)
            clean_query = re.sub(r'^\d+\s*[-_.]?\s*', '', clean_query).strip()
            if clean_query != queries[0]:
                queries.append(clean_query)
            
            if track.artist.lower() in ['unknown', 'unknown artist']:
                 queries.append(track.title)

            results = None
            for q in queries:
                if len(q) < 3: continue
                try:
                    results = search_itunes(q, limit=1)
                    if results: break
                except: pass
            
            if results:
                url = results[0]['artwork_url']
                data = download_image(url)
                if data:
                    with open(dest_path, 'wb') as f:
                        f.write(data)
                    return True
        except:
            pass
        return False


