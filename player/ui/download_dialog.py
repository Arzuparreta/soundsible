
import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')
from gi.repository import Gtk, Adw, GLib, Gio

import threading
import sys
import os
from pathlib import Path

# Note: Try to import odst_tool, looking in parent/adjacent dirs if needed
try:
    from odst_tool.smart_downloader import SmartDownloader
except ImportError:
    # Note: Fallback check for adjacent 'ods-tool' or 'odst-tool' folders
    current_dir = Path(__file__).resolve().parent
    root_dir = current_dir.parent.parent # Note: Soundsible/player/UI -> soundsible
    
    potential_names = ['odst_tool', 'ods-tool', 'ods_tool']
    found = False
    
    # Note: Check inside root first (normal case)
    for name in potential_names:
        p = root_dir / name
        if p.exists() and p.is_dir():
             if str(root_dir) not in sys.path:
                 sys.path.append(str(root_dir))
             # Note: Map package name if needed (e.g. ods-tool -> odst_tool)
             # Note: But we can't easily rename package in python without symlinks or tricks.
             # Note: Simplest add the parent of ods-tool to path? no, that exposes everything.
             # Note: If user cloned 'ods-tool', the package name is 'ods-tool'.
             # Note: But code expects 'odst_tool'.
             # Note: We might need to alias it or just fail gracefully.
             pass

    # Note: Check adjacent to root (user case cloned side-by-side)
    # Note: ../Soundsible -> ../ods-tool
    parent_of_root = root_dir.parent
    for name in potential_names:
        p = parent_of_root / name
        if p.exists() and p.is_dir():
            # Note: Add parent of the tool to sys.path so 'import ods-tool' works
            # Note: But we need 'import odst_tool'.
            # Note: If folder is named 'ods-tool', we can't import it as 'odst_tool'.
            # Note: We will try to mock it or just import what is there.
            
            sys.path.append(str(parent_of_root))
            
            # Note: If the folder is 'ods-tool', we need to alias it?
            # Note: Hack blindly try importing it.
            try:
                if name == 'odst_tool':
                    from odst_tool.smart_downloader import SmartDownloader
                    found = True
                    break
                elif name == 'ods-tool':
                    # Note: Can't simple import with dash.
                    # Note: We can use importlib or just rely on the user having valid name.
                    # Note: But wait, user said "ods-tool".
                    # Note: Let's try to add the folder itself to sys.path?
                    # Note: No, then we import 'smart_downloader' directly.
                    sys.path.append(str(p))
                    try:
                        from smart_downloader import SmartDownloader
                        found = True
                        break
                    except ImportError:
                        pass
            except ImportError:
                continue
    
    if not found:
        # Note: One last desperate try maybe it IS in path but named differently?
        # Note: Just fail gracefully for the class definition helper
        print("Warning: odst_tool module not found. Download features disabled.")
        SmartDownloader = None


class DownloadDialog(Adw.Window):
    """Dialog for downloading music via odst-tool."""
    
    def __init__(self, library_manager=None, **kwargs):
        super().__init__(**kwargs)
        self.library_manager = library_manager
        
        self.set_title("Download Music")
        self.set_default_size(500, 400)
        self.set_modal(True)
        
        # Note: Main layout
        main_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.set_content(main_box)
        
        # Note: Header details
        header = Adw.HeaderBar()
        main_box.append(header)
        
        # Note: Content details
        content_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=24)
        content_box.set_margin_top(24)
        content_box.set_margin_bottom(24)
        content_box.set_margin_start(24)
        content_box.set_margin_end(24)
        main_box.append(content_box)
        
        # Note: Title details
        title_label = Gtk.Label(label="Smart Downloader")
        title_label.add_css_class("title-2")
        content_box.append(title_label)
        
        # Note: Description details
        desc_label = Gtk.Label(label="Enter a song name or YouTube URL.")
        desc_label.add_css_class("dim-label")
        content_box.append(desc_label)
        
        # Note: Input group (multi-line)
        input_group = Adw.PreferencesGroup()
        input_group.set_title("Paste Links (one per line)")
        content_box.append(input_group)
        
        # Note: Scrolled text view for input
        input_scrolled = Gtk.ScrolledWindow()
        input_scrolled.set_min_content_height(100)
        input_scrolled.set_max_content_height(100) # Note: Increased size
        input_scrolled.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        
        self.input_view = Gtk.TextView()
        self.input_view.set_wrap_mode(Gtk.WrapMode.NONE) # Note: No wrap for urls
        self.input_view.set_top_margin(8)
        self.input_view.set_bottom_margin(8)
        self.input_view.set_left_margin(8)
        self.input_view.set_right_margin(8)
        self.input_buffer = self.input_view.get_buffer()
        input_scrolled.set_child(self.input_view)
        
        # Note: Wrap input in a row or box? adwpreferencesgroup expects rows usually?
        # Note: Actually we can just put the scrolled window in the box directly.
        # Note: But to look nice, let's put it in a card-like frame if possible, or just box.
        
        # Note: Create a clamped wrapper for nicer width?
        input_frame = Gtk.Frame()
        input_frame.set_child(input_scrolled)
        input_group.add(input_frame) # Note: Takes widget? no, adds to list_box usually.
        # Note: ADW.preferencesgroup.add() adds A child widget to the box. yes.
        
        # Note: Quality selector
        self.quality_row = Adw.ComboRow()
        self.quality_row.set_title("Download Quality")
        self.quality_row.set_subtitle("Affects file size and audio fidelity")
        
        # Note: Add options (standard, high, ultra)
        model = Gtk.StringList.new(["Standard (128k)", "High Quality (320k)", "Ultra (Best Source)"])
        self.quality_row.set_model(model)
        
        # Note: Set initial quality from config
        self.quality_map = {0: "standard", 1: "high", 2: "ultra"}
        self.quality_map_inv = {"standard": 0, "high": 1, "ultra": 2}
        
        default_quality = "high"
        if self.library_manager and self.library_manager.config:
            default_quality = getattr(self.library_manager.config, 'quality_preference', 'high')
            
        self.quality_row.set_selected(self.quality_map_inv.get(default_quality, 1))
        
        input_group.add(self.quality_row)
        
        # Note: Action button
        self.download_btn = Gtk.Button(label="Start Download")
        self.download_btn.add_css_class("suggested-action")
        self.download_btn.add_css_class("pill")
        self.download_btn.set_halign(Gtk.Align.CENTER)
        self.download_btn.set_margin_top(12)
        self.download_btn.connect("clicked", self.on_download_clicked)
        content_box.append(self.download_btn)
        
        # Note: Progress area
        self.progress_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        self.progress_box.set_visible(False)
        
        self.progress_bar = Gtk.ProgressBar()
        self.status_label = Gtk.Label(label="Initializing...")
        
        # Note: Log view (simple text view)
        scrolled = Gtk.ScrolledWindow()
        scrolled.set_min_content_height(100)
        scrolled.set_max_content_height(150)
        scrolled.set_vexpand(True)
        # Note: Force scrollbars to be automatic
        scrolled.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC) 

        self.log_view = Gtk.TextView()
        self.log_view.set_editable(False)
        self.log_view.set_wrap_mode(Gtk.WrapMode.WORD)
        scrolled.set_child(self.log_view)
        # Note: Store buffer for easier appending
        self.log_buffer = self.log_view.get_buffer()
        
        self.progress_box.append(self.progress_bar)
        self.progress_box.append(self.status_label)
        self.progress_box.append(scrolled)
        
        content_box.append(self.progress_box)
        
    def on_download_clicked(self, btn):
        # Note: Get text from buffer
        start, end = self.input_buffer.get_bounds()
        text = self.input_buffer.get_text(start, end, True)
        
        if not text.strip():
            return
            
        # Note: Parse lines
        lines = [line.strip() for line in text.split('\n') if line.strip()]
        if not lines:
            return

        # Note: Disable input
        self.input_view.set_editable(False)
        self.download_btn.set_sensitive(False)
        
        # Note: Show progress
        self.progress_box.set_visible(True)
        self.progress_bar.pulse()
        self.status_label.set_label("Starting download engine...")
        
        # Note: Clear log
        self.log_buffer.set_text("")
        
        # Note: Get selected quality
        selected_idx = self.quality_row.get_selected()
        selected_quality = self.quality_map.get(selected_idx, "high")
        
        # Note: Start thread
        self.download_thread = threading.Thread(
            target=self._run_process, 
            args=(lines, selected_quality), 
            daemon=True
        )
        self.download_thread.start()
        
    def _log_ui(self, msg, level="info"):
        """Append to log view thread-safely."""
        def _update():
            end_iter = self.log_buffer.get_end_iter()
            
            prefix = "• "
            if level == "error": prefix = "❌ "
            elif level == "warning": prefix = "⚠ "
            elif level == "success": prefix = "✅ "
                
            self.log_buffer.insert(end_iter, f"{prefix}{msg}\n")
            
            # Note: Auto scroll
            mark = self.log_buffer.create_mark(None, end_iter, False)
            self.log_view.scroll_to_mark(mark, 0.0, True, 0.0, 1.0)
            
            # Note: Update status label with last message
            self.status_label.set_label(msg)
            return False
            
        GLib.idle_add(_update)
        
    def _run_process(self, queries, quality):
        downloader = SmartDownloader()
        downloader.set_log_callback(self._log_ui)
        
        success_count = 0
        total = len(queries)
        downloaded_tracks = [] # Note: Keep track of actual track objects
        
        try:
            GLib.idle_add(self.progress_bar.pulse)
            self._log_ui(f"Processing {total} items (Quality: {quality})...", "info")
            
            any_success = False
            
            for i, query in enumerate(queries):
                self._log_ui(f"[{i+1}/{total}] Processing: {query}", "info")
                GLib.idle_add(lambda v=i/total: self.progress_bar.set_fraction(v))
                
                try:
                    track = downloader.process_query(query, quality=quality)
                    
                    if track:
                        self._log_ui(f"Downloaded: {track.title}", "success")
                        downloaded_tracks.append(track)
                        success_count += 1
                        any_success = True
                    else:
                        self._log_ui(f"Failed to find track for: {query}", "error")
                except Exception as e:
                    self._log_ui(f"Error processing item: {e}", "error")
            
            # Note: Upload phase
            if any_success:
                self._log_ui("Starting batch upload...", "info")
                GLib.idle_add(self.progress_bar.pulse)
                
                updated_library = downloader.upload_to_cloud()
                
                if updated_library:
                     # Note: Critical FIX integrate tracks and covers before cleaning staging
                     if self.library_manager:
                         self._log_ui("Proactively caching tracks and covers...", "info")
                         
                         from setup_tool.audio import AudioProcessor
                         from shared.constants import DEFAULT_CACHE_DIR
                         covers_dir = os.path.join(os.path.expanduser(DEFAULT_CACHE_DIR), "covers")
                         os.makedirs(covers_dir, exist_ok=True)

                         for t in downloaded_tracks:
                             # Note: 1. Seed audio cache
                             if self.library_manager.cache and hasattr(t, 'local_path') and t.local_path:
                                 self.library_manager.cache.add_to_cache(t.id, t.local_path, move=False)
                             
                             # Note: 2. Extract and cache cover art
                             try:
                                 if hasattr(t, 'local_path') and t.local_path:
                                     cover_data = AudioProcessor.extract_cover_art(t.local_path)
                                     if cover_data:
                                         with open(os.path.join(covers_dir, f"{t.id}.jpg"), 'wb') as f:
                                             f.write(cover_data)
                             except Exception as ce:
                                 print(f"DEBUG: Proactive cover extraction failed for {t.title}: {ce}")
                     
                     GLib.idle_add(lambda: self.progress_bar.set_fraction(1.0))
                     self._log_ui("All operations completed successfully!", "success")
                     
                     # Note: Trigger library refresh with injected metadata
                     parent = self.get_transient_for()
                     if parent and hasattr(parent, 'refresh_library'):
                         GLib.idle_add(parent.refresh_library, updated_library)
                         self._log_ui("Library updated instantly.", "info")
                else:
                     self._log_ui("Upload failed.", "error")
            else:
                 self._log_ui("No tracks were downloaded successfully.", "warning")
                 GLib.idle_add(lambda: self.progress_bar.set_fraction(0.0))
                
        except Exception as e:
            self._log_ui(f"Critical Error: {e}", "error")
            import traceback
            traceback.print_exc()
            
        finally:
            downloader.cleanup()
            GLib.idle_add(self._on_finished)
            
    def _on_finished(self):
        self.input_view.set_editable(True)
        self.download_btn.set_sensitive(True)
        # Note: Clear input so user can enter new links
        self.input_buffer.set_text("") 
        self.status_label.set_label("Ready for next batch")
