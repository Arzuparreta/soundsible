
import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')
from gi.repository import Gtk, Adw, GLib, Gio

import threading
from odst_tool.smart_downloader import SmartDownloader

class DownloadDialog(Adw.Window):
    """Dialog for downloading music via odst-tool."""
    
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        
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
        
        # Start thread
        self.download_thread = threading.Thread(target=self._run_process, args=(lines,), daemon=True)
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
        
    def _run_process(self, queries):
        downloader = SmartDownloader()
        downloader.set_log_callback(self._log_ui)
        
        success_count = 0
        total = len(queries)
        
        try:
            GLib.idle_add(self.progress_bar.pulse)
            self._log_ui(f"Processing {total} items...", "info")
            
            any_success = False
            
            for i, query in enumerate(queries):
                self._log_ui(f"[{i+1}/{total}] Processing: {query}", "info")
                GLib.idle_add(lambda v=i/total: self.progress_bar.set_fraction(v))
                
                try:
                    track = downloader.process_query(query)
                    
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
