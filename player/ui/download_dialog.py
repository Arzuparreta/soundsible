
import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')
from gi.repository import Gtk, Adw, GLib, Gio

import threading
import sys
import os
from pathlib import Path

# Try to import odst_tool, looking in parent/adjacent dirs if needed
try:
    from odst_tool.smart_downloader import SmartDownloader
except ImportError:
    # Fallback: Check for adjacent 'ods-tool' or 'odst-tool' folders
    current_dir = Path(__file__).resolve().parent
    root_dir = current_dir.parent.parent # soundsible/player/ui -> soundsible
    
    potential_names = ['odst_tool', 'ods-tool', 'ods_tool']
    found = False
    
    # Check inside root first (normal case)
    for name in potential_names:
        p = root_dir / name
        if p.exists() and p.is_dir():
             if str(root_dir) not in sys.path:
                 sys.path.append(str(root_dir))
             # Map package name if needed (e.g. ods-tool -> odst_tool)
             # But we can't easily rename package in python without symlinks or tricks.
             # Simplest: Add the PARENT of ods-tool to path? No, that exposes everything.
             # If user cloned 'ods-tool', the package name is 'ods-tool'.
             # But code expects 'odst_tool'. 
             # We might need to alias it or just fail gracefully.
             pass

    # Check ADJACENT to root (user case: cloned side-by-side)
    # ../soundsible -> ../ods-tool
    parent_of_root = root_dir.parent
    for name in potential_names:
        p = parent_of_root / name
        if p.exists() and p.is_dir():
            # Add PARENT of the tool to sys.path so 'import ods-tool' works
            # But we need 'import odst_tool'. 
            # If folder is named 'ods-tool', we can't import it as 'odst_tool'.
            # We will try to mock it or just import what is there.
            
            sys.path.append(str(parent_of_root))
            
            # If the folder is 'ods-tool', we need to alias it?
            # Hack: blindly try importing it.
            try:
                if name == 'odst_tool':
                    from odst_tool.smart_downloader import SmartDownloader
                    found = True
                    break
                elif name == 'ods-tool':
                    # Can't simple import with dash.
                    # We can use importlib or just rely on the user having valid name.
                    # But wait, user said "ods-tool".
                    # Let's try to add the folder ITSELF to sys.path?
                    # No, then we import 'smart_downloader' directly.
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
        # One last desperate try: maybe it IS in path but named differently?
        # Just fail gracefully for the class definition helper
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
        
        # Main layout
        main_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.set_content(main_box)
        
        # Header
        header = Adw.HeaderBar()
        main_box.append(header)
        
        # Content
        content_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=24)
        content_box.set_margin_top(24)
        content_box.set_margin_bottom(24)
        content_box.set_margin_start(24)
        content_box.set_margin_end(24)
        main_box.append(content_box)
        
        # Title
        title_label = Gtk.Label(label="Smart Downloader")
        title_label.add_css_class("title-2")
        content_box.append(title_label)
        
        # Description
        desc_label = Gtk.Label(label="Enter a song name, YouTube URL, or Spotify URL.")
        desc_label.add_css_class("dim-label")
        content_box.append(desc_label)
        
        # Input Group (Multi-line)
        input_group = Adw.PreferencesGroup()
        input_group.set_title("Paste Links (one per line)")
        content_box.append(input_group)
        
        # Scrolled Text View for Input
        input_scrolled = Gtk.ScrolledWindow()
        input_scrolled.set_min_content_height(100)
        input_scrolled.set_max_content_height(100) # Increased size
        input_scrolled.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        
        self.input_view = Gtk.TextView()
        self.input_view.set_wrap_mode(Gtk.WrapMode.NONE) # No wrap for URLs
        self.input_view.set_top_margin(8)
        self.input_view.set_bottom_margin(8)
        self.input_view.set_left_margin(8)
        self.input_view.set_right_margin(8)
        self.input_buffer = self.input_view.get_buffer()
        input_scrolled.set_child(self.input_view)
        
        # Wrap input in a row or box? AdwPreferencesGroup expects Rows usually?
        # Actually we can just put the scrolled window in the box directly.
        # But to look nice, let's put it in a card-like frame if possible, or just box.
        
        # Create a clamped wrapper for nicer width?
        input_frame = Gtk.Frame()
        input_frame.set_child(input_scrolled)
        input_group.add(input_frame) # Takes widget? No, adds to list_box usually.
        # Adw.PreferencesGroup.add() adds a child widget to the box. Yes.
        
        # Quality Selector
        self.quality_row = Adw.ComboRow()
        self.quality_row.set_title("Download Quality")
        self.quality_row.set_subtitle("Affects file size and audio fidelity")
        
        # Add options (Standard, High, Ultra)
        model = Gtk.StringList.new(["Standard (128k)", "High Quality (320k)", "Ultra (Best Source)"])
        self.quality_row.set_model(model)
        
        # Set initial quality from config
        self.quality_map = {0: "standard", 1: "high", 2: "ultra"}
        self.quality_map_inv = {"standard": 0, "high": 1, "ultra": 2}
        
        default_quality = "high"
        if self.library_manager and self.library_manager.config:
            default_quality = getattr(self.library_manager.config, 'quality_preference', 'high')
            
        self.quality_row.set_selected(self.quality_map_inv.get(default_quality, 1))
        
        input_group.add(self.quality_row)
        
        # Action Button
        self.download_btn = Gtk.Button(label="Start Download")
        self.download_btn.add_css_class("suggested-action")
        self.download_btn.add_css_class("pill")
        self.download_btn.set_halign(Gtk.Align.CENTER)
        self.download_btn.set_margin_top(12)
        self.download_btn.connect("clicked", self.on_download_clicked)
        content_box.append(self.download_btn)
        
        # Progress Area
        self.progress_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        self.progress_box.set_visible(False)
        
        self.progress_bar = Gtk.ProgressBar()
        self.status_label = Gtk.Label(label="Initializing...")
        
        # Log view (simple text view)
        scrolled = Gtk.ScrolledWindow()
        scrolled.set_min_content_height(100)
        scrolled.set_max_content_height(150)
        scrolled.set_vexpand(True)
        # Force scrollbars to be automatic
        scrolled.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC) 

        self.log_view = Gtk.TextView()
        self.log_view.set_editable(False)
        self.log_view.set_wrap_mode(Gtk.WrapMode.WORD)
        scrolled.set_child(self.log_view)
        # Store buffer for easier appending
        self.log_buffer = self.log_view.get_buffer()
        
        self.progress_box.append(self.progress_bar)
        self.progress_box.append(self.status_label)
        self.progress_box.append(scrolled)
        
        content_box.append(self.progress_box)
        
    def on_download_clicked(self, btn):
        # Get text from buffer
        start, end = self.input_buffer.get_bounds()
        text = self.input_buffer.get_text(start, end, True)
        
        if not text.strip():
            return
            
        # Parse lines
        lines = [line.strip() for line in text.split('\n') if line.strip()]
        if not lines:
            return

        # Disable input
        self.input_view.set_editable(False)
        self.download_btn.set_sensitive(False)
        
        # Show progress
        self.progress_box.set_visible(True)
        self.progress_bar.pulse()
        self.status_label.set_label("Starting download engine...")
        
        # Clear log
        self.log_buffer.set_text("")
        
        # Get selected quality
        selected_idx = self.quality_row.get_selected()
        selected_quality = self.quality_map.get(selected_idx, "high")
        
        # Start thread
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
            
            # Auto scroll
            mark = self.log_buffer.create_mark(None, end_iter, False)
            self.log_view.scroll_to_mark(mark, 0.0, True, 0.0, 1.0)
            
            # Update status label with last message
            self.status_label.set_label(msg)
            return False
            
        GLib.idle_add(_update)
        
    def _run_process(self, queries, quality):
        downloader = SmartDownloader()
        downloader.set_log_callback(self._log_ui)
        
        success_count = 0
        total = len(queries)
        
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
                        success_count += 1
                        any_success = True
                    else:
                        self._log_ui(f"Failed to find track for: {query}", "error")
                except Exception as e:
                    self._log_ui(f"Error processing item: {e}", "error")
            
            # Upload Phase
            if any_success:
                self._log_ui("Starting batch upload...", "info")
                GLib.idle_add(self.progress_bar.pulse)
                
                upload_success = downloader.upload_to_cloud()
                
                if upload_success:
                     GLib.idle_add(lambda: self.progress_bar.set_fraction(1.0))
                     self._log_ui("All operations completed successfully!", "success")
                     
                     # Trigger Library Refresh
                     parent = self.get_transient_for()
                     if parent and hasattr(parent, 'refresh_library'):
                         GLib.idle_add(parent.refresh_library)
                         self._log_ui("Library refresh requested.", "info")
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
        # Clear input so user can enter new links
        self.input_buffer.set_text("") 
        self.status_label.set_label("Ready for next batch")
