import sys
import os

try:
    import tkinter as tk
    from tkinter import ttk, messagebox, scrolledtext
except ImportError:
    print("\n" + "!"*60)
    print("CRITICAL ERROR: Desktop GUI libraries (tkinter) are missing.")
    print("This is common on some Linux setups.")
    print("--> Use the embedded downloader in the main webapp instead:")
    print("    http://localhost:5005/player/")
    print("    (Ensure the Soundsible API is running on port 5005.)")
    print("!"*60 + "\n")
    sys.exit(1)
import threading
import sys
from pathlib import Path
from typing import List, Dict, Any

from .config import DEFAULT_OUTPUT_DIR, DEFAULT_WORKERS, DEFAULT_COOKIE_BROWSER
from .odst_downloader import ODSTDownloader
from .cloud_sync import CloudSync
import shutil
import os

class DownloaderGUI:
    def __init__(self, root):
        self.root = root
        self.root.title("Music Downloader")
        self.root.geometry("600x500")
        
        # Initialize Backend
        self.app = self._init_backend()
        self.cloud = CloudSync(self.app.output_dir)
        self.queue = []
        self.input_mode = "manual"  # manual vs spotify
        
        self._setup_ui()
        
    def _init_backend(self):
        return ODSTDownloader(
            DEFAULT_OUTPUT_DIR,
            DEFAULT_WORKERS,
            cookie_browser=DEFAULT_COOKIE_BROWSER,
        )

    def _setup_ui(self):
        # Header
        header = ttk.Frame(self.root, padding="10")
        header.pack(fill=tk.X)
        ttk.Label(header, text="Music Downloader", font=("Helvetica", 16, "bold")).pack(side=tk.LEFT)
        
        # Input Area
        input_frame = ttk.LabelFrame(self.root, text="Add Music", padding="10")
        input_frame.pack(fill=tk.X, padx=10, pady=5)
        
        # Tabs for Source (Manual vs Spotify)
        self.notebook = ttk.Notebook(input_frame)
        self.notebook.pack(fill=tk.X, expand=True)
        
        # Manual Tab
        manual_frame = ttk.Frame(self.notebook, padding="5")
        self.notebook.add(manual_frame, text="Manual Input")
        
        ttk.Label(manual_frame, text="Enter YouTube URL or Song Name (Artist - Title):").pack(anchor="w")
        self.manual_entry = ttk.Entry(manual_frame, width=50)
        self.manual_entry.pack(fill=tk.X, pady=5)
        self.manual_entry.bind("<Return>", lambda e: self.add_to_queue())
        
        ttk.Button(manual_frame, text="Add to Queue", command=self.add_to_queue).pack(anchor="e")

        # Settings Tab
        settings_frame = ttk.Frame(self.notebook, padding="5")
        self.notebook.add(settings_frame, text="Settings")
        
        # Danger Zone
        danger_frame = ttk.LabelFrame(settings_frame, text="Danger Zone", padding="10")
        danger_frame.pack(fill=tk.X, pady=10)
        
        ttk.Label(danger_frame, text="Warning: This will delete ALL songs from Cloud and Local storage.").pack(pady=5)
        btn_delete_all = tk.Button(danger_frame, text="ERASE EVERYTHING", bg="#ffcccc", fg="red", command=self.confirm_and_erase_all)
        btn_delete_all.pack(fill=tk.X)
        
        # Queue Area
        queue_frame = ttk.LabelFrame(self.root, text="Download Queue", padding="10")
        queue_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)
        
        self.queue_list = tk.Listbox(queue_frame, selectmode=tk.SINGLE)
        self.queue_list.pack(fill=tk.BOTH, expand=True, side=tk.LEFT)
        
        scrollbar = ttk.Scrollbar(queue_frame, orient="vertical", command=self.queue_list.yview)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.queue_list.config(yscrollcommand=scrollbar.set)
        
        control_frame = ttk.Frame(self.root, padding="10")
        control_frame.pack(fill=tk.X)
        
        # Direct to Cloud Option
        self.direct_to_cloud_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(control_frame, text="Direct to Cloud (Upload & Delete Local)", variable=self.direct_to_cloud_var).pack(side=tk.LEFT)
        
        self.btn_download = ttk.Button(control_frame, text="Start Download", command=self.start_download)
        self.btn_download.pack(side=tk.RIGHT)
        
        ttk.Button(control_frame, text="Clear Queue", command=self.clear_queue).pack(side=tk.RIGHT, padx=5)

        # Log Area
        log_frame = ttk.LabelFrame(self.root, text="Logs", padding="5")
        log_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)
        self.log_area = scrolledtext.ScrolledText(log_frame, height=8, state='disabled')
        self.log_area.pack(fill=tk.BOTH, expand=True)

    def log(self, message):
        self.log_area.config(state='normal')
        self.log_area.insert(tk.END, message + "\n")
        self.log_area.see(tk.END)
        self.log_area.config(state='disabled')

    def add_to_queue(self):
        text = self.manual_entry.get().strip()
        if not text:
            return
            
        if " - " not in text:
            self.log(f"⚠️ Format warning: Use 'Artist - Title' for best results (Input: {text})")
            
        self.queue.append(text)
        self.queue_list.insert(tk.END, text)
        self.manual_entry.delete(0, tk.END)
        self.log(f"Added to queue: {text}")

    def clear_queue(self):
        self.queue = []
        self.queue_list.delete(0, tk.END)
        self.log("Queue cleared.")

    def start_download(self):
        if not self.queue:
            messagebox.showwarning("Empty Queue", "Please add songs to the queue first.")
            return
            
        self.btn_download.config(state="disabled")
        self.log("--- Starting Download ---")
        
        # Run in thread to not freeze UI
        threading.Thread(target=self._download_thread, daemon=True).start()

    def _download_thread(self):
        for song_str in list(self.queue):
            try:
                self.log(f"Processing: {song_str}...")
                
                track = None
                
                # Check if it's a URL
                if song_str.strip().startswith("http"):
                    self.log("Detected URL mode...")
                    track = self.app.downloader.process_video(song_str.strip())
                else:
                    # Manual artist - title input
                    # Mock metadata creation
                    parts = song_str.split("-")
                    artist = parts[0].strip()
                    title = parts[1].strip() if len(parts) > 1 else song_str.strip()
                    
                    fake_meta = {
                        'title': title,
                        'artist': artist,
                        'album': 'Manual Download',
                        'duration_ms': 0, # Signal to skip duration check?
                        'duration_sec': 0,
                        'release_date': None,
                        'track_number': None,
                        'id': f"manual_{hash(song_str)}",
                        'album_art_url': None
                    }
                    
                    track = self.app.downloader.process_track(fake_meta)
                
                if track:
                    self.app.library.add_track(track)
                    self.log(f"Downloaded: {track.artist} - {track.title}")
                    # Remove from UI list
                    self._remove_from_listbox(song_str)
                else:
                    self.log(f"Failed: {song_str}")
                    
            except Exception as e:
                self.log(f"Error: {e}")
                
        self.app.save_library()
        self.log("--- Download Complete ---")
        
        # Auto Sync (Direct to Cloud)
        if self.direct_to_cloud_var.get():
            self.log("☁️ Starting Direct-to-Cloud Sync (Upload & Delete Local)...")
            
            # Run sync in thread or same thread? Same thread is fine here since we are already in bg thread.
            try:
                stats = self.cloud.sync_library(
                    self.app.library, 
                    progress_callback=self.log, 
                    delete_local=True
                )
                
                if "error" in stats:
                     self.log(f"Sync Error: {stats['error']}")
                else:
                    self.log(f"Sync Done: Uploaded {stats['uploaded']}, Deleted {stats['deleted']} local files.")
            except Exception as e:
                self.log(f"Sync Exception: {e}")
        
        self.root.after(0, lambda: self.btn_download.config(state="normal"))

    def _remove_from_listbox(self, item_text):
        # Find index
        try:
            # Tkinter listbox get() returns tuple of all items
            idx = self.queue_list.get(0, tk.END).index(item_text)
            self.queue_list.delete(idx)
        except ValueError:
            pass

    def confirm_and_erase_all(self):
        answer = messagebox.askyesno("CONFIRM DELETION", "Are you sure you want to delete ALL music from the Remote Bucket AND Local Storage?\n\nThis cannot be undone.")
        if not answer:
            return
            
        answer2 = messagebox.askyesno("DOUBLE CHECK", "Really? This will wipe your 1500 songs if they are there.")
        if not answer2:
            return
            
        self.log("--- STARTING TOTAL ERASURE ---")
        threading.Thread(target=self._erase_all_thread, daemon=True).start()

    def _erase_all_thread(self):
        # 1. Cloud Delete
        self.log("Connecting to Cloudflare R2...")
        if self.cloud.is_configured():
            self.cloud.delete_all_remote_files(progress_callback=self.log)
        else:
            self.log("Skipping Cloud (Not Configured).")
            
        # 2. Local Delete
        self.log("Deleting local files...")
        tracks_dir = self.app.output_dir / "tracks"
        if tracks_dir.exists():
            try:
                shutil.rmtree(tracks_dir)
                tracks_dir.mkdir(exist_ok=True) # Recreate empty
                self.log("Local tracks folder cleared.")
            except Exception as e:
                self.log(f"Error clearing local tracks: {e}")
        
        # 3. Library JSON Delete
        lib_path = self.app.library_path
        if lib_path.exists():
            try:
                os.remove(lib_path)
                self.log("library.json deleted.")
            except Exception as e:
                self.log(f"Error deleting library.json: {e}")
                
        # 4. Reset Memory
        self.app.library = self.app._load_library()
        self.log("Memory state reset.")
        self.log("--- ERASURE COMPLETE ---")
        messagebox.showinfo("Done", "Library has been completely erased.")

def main():
    root = tk.Tk()
    # Apply theme/style
    style = ttk.Style()
    style.theme_use('clam')
    
    app = DownloaderGUI(root)
    root.mainloop()

if __name__ == "__main__":
    main()
