import concurrent.futures
import io
import os
import threading

from shared.constants import DEFAULT_CACHE_DIR
from setup_tool.audio import AudioProcessor

#: Longest edge for the list/grid thumbnail variant. One size covers both a
#: retina row (44-60px) and a grid tile (120-300px) without adding more tiers.
THUMB_EDGE = 320


class CoverFetchManager:
    _instance = None
    
    @classmethod
    def get_instance(cls):
        if not cls._instance:
            cls._instance = cls()
        return cls._instance

    def __init__(self):
        self.callbacks = {} # Note: Map track_id -> list of callbacks(path)
        self.lock = threading.Lock()
        
        self.covers_dir = os.path.join(os.path.expanduser(DEFAULT_CACHE_DIR), "covers")
        os.makedirs(self.covers_dir, exist_ok=True)
        
        # Note: Bounded thread pool
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="CoverWorker")
        self.submitted_tracks = set() # Note: Track ids currently in pool

    def get_cached_path(self, track_id):
        path = os.path.join(self.covers_dir, f"{track_id}.jpg")
        if os.path.exists(path):
            return path
        return None

    def get_cached_thumb_path(self, track_id):
        path = os.path.join(self.covers_dir, f"{track_id}_thumb.jpg")
        if os.path.exists(path):
            return path
        return None

    def _write_thumbnail(self, cover_data, thumb_path):
        """Resize embedded art down to THUMB_EDGE and cache it as a JPEG.

        Best-effort: a thumbnail that fails to generate just means callers
        keep serving the full-size original, never a broken response.
        """
        try:
            from PIL import Image

            img = Image.open(io.BytesIO(cover_data))
            if img.mode in ("RGBA", "P", "LA"):
                img = img.convert("RGB")
            img.thumbnail((THUMB_EDGE, THUMB_EDGE), Image.LANCZOS)
            img.save(thumb_path, "JPEG", quality=82, optimize=True)
        except Exception:
            pass

    def extract_thumb_now(self, track_id, original_path):
        """Generate the thumbnail for a cover cached before thumbnails existed.

        Reads the already-cached original off disk — no audio re-parse.
        """
        thumb_path = os.path.join(self.covers_dir, f"{track_id}_thumb.jpg")
        if os.path.exists(thumb_path):
            return thumb_path
        try:
            with open(original_path, "rb") as handle:
                cover_data = handle.read()
        except OSError:
            return None
        self._write_thumbnail(cover_data, thumb_path)
        return thumb_path if os.path.exists(thumb_path) else None

    def request_cover(self, track, embedded_cache_info=None, callback=None):
        """
        Request a cover for a track.
        Callback receives: (cover_path)
        """
        # Note: 1. Check smart cache (fastest)
        path = self.get_cached_path(track.id)
        if path:
             if callback:
                 with self.lock:
                    if track.id not in self.callbacks:
                        self.callbacks[track.id] = []
                    self.callbacks[track.id].append(callback)
                 self.executor.submit(self._notify_success, track.id, path)
             return

        # Note: 2. Register callback
        if callback:
            with self.lock:
                if track.id not in self.callbacks:
                    self.callbacks[track.id] = []
                self.callbacks[track.id].append(callback)

        # Note: 3. Submit to pool if not already running
        with self.lock:
            if track.id not in self.submitted_tracks:
                self.submitted_tracks.add(track.id)
                self.executor.submit(self._process_track, track, embedded_cache_info)

    def _process_track(self, track, embedded_path):
        try:
            dest_path = os.path.join(self.covers_dir, f"{track.id}.jpg")
            
            # Note: Double check if appeared while waiting
            if os.path.exists(dest_path):
                self._notify_success(track.id, dest_path)
                return

            found = False

            # Note: A. try embedded art (medium)
            if embedded_path and os.path.exists(embedded_path):
                try:
                    cover_data = AudioProcessor.extract_cover_art(embedded_path)
                    if cover_data:
                        with open(dest_path, 'wb') as f:
                            f.write(cover_data)
                        self._write_thumbnail(cover_data, os.path.join(self.covers_dir, f"{track.id}_thumb.jpg"))
                        found = True
                except Exception:
                    pass

            if found:
                self._notify_success(track.id, dest_path)
            elif os.path.exists(dest_path):
                 # Note: Fallback if found earlier but logic skipped
                 self._notify_success(track.id, dest_path)

        except Exception as e:
            print(f"Error processing cover for {track.title}: {e}")
        finally:
            with self.lock:
                self.submitted_tracks.discard(track.id)

    def _notify_success(self, track_id, cover_path):
        with self.lock:
            cbs = self.callbacks.pop(track_id, [])
        for cb in cbs:
            try:
                cb(cover_path)
            except Exception:
                pass

    def extract_now(self, track, source_path) -> str | None:
        """Pull the embedded artwork out of a file, synchronously, and cache it.

        `request_cover` is the asynchronous path the UI uses: it returns
        immediately and fills the cache behind the listener. A route serving
        one cover cannot return "later", so it comes through here instead —
        same directory, same filename, so whichever runs first serves both.
        """
        if not source_path or str(source_path).startswith("http"):
            return None
        dest_path = os.path.join(self.covers_dir, f"{track.id}.jpg")
        if os.path.exists(dest_path):
            return dest_path
        try:
            cover_data = AudioProcessor.extract_cover_art(str(source_path))
            if not cover_data:
                return None
            with open(dest_path, "wb") as handle:
                handle.write(cover_data)
            self._write_thumbnail(cover_data, os.path.join(self.covers_dir, f"{track.id}_thumb.jpg"))
            return dest_path
        except Exception:
            return None


