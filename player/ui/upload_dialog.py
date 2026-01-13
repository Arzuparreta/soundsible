"""
Music upload dialog for uploading audio files to cloud storage.
"""

import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')
from gi.repository import Gtk, Adw, GLib, Gio

from pathlib import Path
import threading
import tempfile
from setup_tool.uploader import UploadEngine
from setup_tool.audio import AudioProcessor
from setup_tool.metadata import search_itunes, download_image


class UploadDialog(Adw.Window):
    """Dialog for uploading music files to cloud storage."""
    
    def __init__(self, config, **kwargs):
        super().__init__(**kwargs)
        
        self.config = config
        self.selected_path = None
        self.file_count = 0
        self.is_uploading = False
        self.cover_image_path = None
        
        self.set_title("Upload Music (Hyprland Safe)")
        self.set_default_size(600, 750)
        self.set_modal(True)
        
        # Main layout container
        main_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.set_content(main_box)
        
        # 1. Header Bar
        header = Adw.HeaderBar()
        main_box.append(header)
        
        # 2. Scrolled Window (Expands to fill available space)
        scrolled = Gtk.ScrolledWindow()
        scrolled.set_vexpand(True)
        scrolled.set_hexpand(True)
        # Force scrollbars to be automatic
        scrolled.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC) 
        main_box.append(scrolled)
        
        # 3. Content Box (Inside Scroll)
        content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=24)
        content.set_margin_top(24)
        content.set_margin_bottom(24)
        content.set_margin_start(24)
        content.set_margin_end(24)
        scrolled.set_child(content)
        
        # --- UI ELEMENTS ---
        
        # Title
        title = Gtk.Label(label="Upload Music")
        title.add_css_class("title-2")
        content.append(title)
        
        # GROUP 1: Selection
        folder_group = Adw.PreferencesGroup()
        folder_group.set_title("1. Select Music Source")
        
        # Folder Row
        self.folder_row = Adw.ActionRow()
        self.folder_row.set_title("Select Folder")
        self.folder_row.set_subtitle("Choose a directory")
        
        folder_btn = Gtk.Button(icon_name="folder-open-symbolic")
        folder_btn.set_valign(Gtk.Align.CENTER)
        folder_btn.set_tooltip_text("Select Folder")
        folder_btn.connect('clicked', self.on_select_folder)
        self.folder_row.add_suffix(folder_btn)
        folder_group.add(self.folder_row)
        
        # File Row
        self.file_row = Adw.ActionRow()
        self.file_row.set_title("Select File")
        self.file_row.set_subtitle("Choose a single file")
        
        # Use emblem-music-symbolic as it is more reliable than audio-x-generic
        file_btn = Gtk.Button(icon_name="emblem-music-symbolic") 
        file_btn.set_valign(Gtk.Align.CENTER)
        file_btn.set_tooltip_text("Select File")
        file_btn.connect('clicked', self.on_select_file)
        self.file_row.add_suffix(file_btn)
        folder_group.add(self.file_row)
        
        content.append(folder_group)
        
        # File info label
        self.file_info = Gtk.Label(label="No file selected")
        self.file_info.add_css_class("dim-label")
        content.append(self.file_info)

        # GROUP 2: Metadata & Art (Moved UP for visibility)
        meta_group = Adw.PreferencesGroup()
        meta_group.set_title("2. Metadata & Album Art")
        
        # Search Entry (Safe Gtk.SearchEntry implementation)
        self.search_row = Adw.ActionRow()
        self.search_row.set_title("Search Metadata")
        self.search_row.set_subtitle("Type song name to find cover")
        
        self.search_entry = Gtk.SearchEntry()
        self.search_entry.set_placeholder_text("e.g. Halo 3 ODST Rain")
        self.search_entry.set_valign(Gtk.Align.CENTER)
        self.search_entry.set_hexpand(True)
        self.search_entry.connect('search-changed', self.on_search_entry_changed)
        self.search_entry.connect('activate', self.on_search_submit)
        
        self.search_row.add_suffix(self.search_entry)
        meta_group.add(self.search_row)
        
        # Preview & Manual Select
        preview_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        
        # Left: Controls
        left_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        left_box.set_valign(Gtk.Align.CENTER)
        
        self.auto_fetch_btn = Gtk.Button(label="🪄 Auto-Fetch")
        self.auto_fetch_btn.connect('clicked', self.on_auto_fetch)
        left_box.append(self.auto_fetch_btn)
        
        self.select_cover_btn = Gtk.Button(label="📁 Select Image")
        self.select_cover_btn.connect('clicked', self.on_select_cover)
        left_box.append(self.select_cover_btn)
        
        preview_box.append(left_box)
        
        # Right: Image
        self.cover_preview = Gtk.Image()
        self.cover_preview.set_pixel_size(100)
        self.cover_preview.set_size_request(100, 100)
        self.cover_preview.add_css_class("card")
        self.cover_preview.set_from_icon_name("emblem-music-symbolic")
        
        img_wrap = Gtk.Box()
        img_wrap.set_hexpand(True)
        img_wrap.set_halign(Gtk.Align.END)
        img_wrap.append(self.cover_preview)
        preview_box.append(img_wrap)
        
        # Wrap preview in a row
        preview_row = Adw.PreferencesRow()
        preview_row.set_child(preview_box)
        preview_box.set_margin_top(12)
        preview_box.set_margin_bottom(12)
        preview_box.set_margin_start(12)
        preview_box.set_margin_end(12)
        
        meta_group.add(preview_row)
        content.append(meta_group)
        
        # GROUP 3: Options (Moved Down)
        options_group = Adw.PreferencesGroup()
        options_group.set_title("3. Upload Options")
        
        # Auto-Fetch Toggle
        self.auto_fetch_row = Adw.SwitchRow()
        self.auto_fetch_row.set_title("Batch Auto-Fetch")
        self.auto_fetch_row.set_subtitle("Fetch covers for all files")
        self.auto_fetch_row.set_active(True)
        options_group.add(self.auto_fetch_row)

        # Compress toggle
        self.compress_row = Adw.SwitchRow()
        self.compress_row.set_title("Convert to MP3")
        self.compress_row.set_active(True)
        options_group.add(self.compress_row)
        
        content.append(options_group)
        
        # Progress Area
        self.progress_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.progress_box.set_visible(False)
        self.progress_bar = Gtk.ProgressBar()
        self.status_label = Gtk.Label(label="Ready")
        self.progress_box.append(self.progress_bar)
        self.progress_box.append(self.status_label)
        
        content.append(self.progress_box)
        
        # 4. Bottom Buttons (Fixed at bottom)
        button_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        button_box.set_margin_top(12)
        button_box.set_margin_bottom(12)
        button_box.set_margin_end(24)
        button_box.set_halign(Gtk.Align.END)
        
        self.cancel_btn = Gtk.Button(label="Cancel")
        self.cancel_btn.connect('clicked', lambda b: self.close())
        button_box.append(self.cancel_btn)
        
        self.upload_btn = Gtk.Button(label="Upload Music")
        self.upload_btn.add_css_class("suggested-action")
        self.upload_btn.set_sensitive(False)
        self.upload_btn.connect('clicked', self.on_upload_clicked)
        button_box.append(self.upload_btn)
        
        main_box.append(button_box)
        
    # --- LOGIC HANDLERS ---
    
    def on_bitrate_changed(self, scale):
        pass # Not used currently
    
    def on_parallel_changed(self, scale):
        pass # Not used currently
    
    def on_select_folder(self, button):
        """Open folder chooser dialog."""
        dialog = Gtk.FileDialog()
        dialog.set_title("Select Music Folder")
        dialog.select_folder(parent=self, callback=self.on_folder_selected)
    
    def on_select_file(self, button):
        """Open file chooser dialog."""
        dialog = Gtk.FileDialog()
        dialog.set_title("Select Music File")
        filters = Gio.ListStore.new(Gtk.FileFilter)
        audio_filter = Gtk.FileFilter()
        audio_filter.set_name("Audio Files")
        audio_filter.add_mime_type("audio/*")
        filters.append(audio_filter)
        dialog.set_filters(filters)
        dialog.open(parent=self, callback=self.on_file_selected)
    
    def on_select_cover(self, button):
        """Manually select cover image."""
        dialog = Gtk.FileDialog()
        dialog.set_title("Select Cover Image")
        filters = Gio.ListStore.new(Gtk.FileFilter)
        img_filter = Gtk.FileFilter()
        img_filter.set_name("Images")
        img_filter.add_mime_type("image/*")
        filters.append(img_filter)
        dialog.set_filters(filters)
        dialog.open(parent=self, callback=self.on_cover_selected)
    
    def on_cover_selected(self, dialog, result):
        try:
            file = dialog.open_finish(result)
            if file:
                self.cover_image_path = file.get_path()
                self._update_cover_preview(self.cover_image_path)
        except Exception as e:
            print(f"Cover selection error: {e}")

    def on_auto_fetch(self, button):
        """Try to guess and fetch metadata."""
        query = ""
        if self.selected_path:
            # Smart cleanup logic (ported from uploader)
            path = Path(self.selected_path)
            stem = path.stem
            
            # 1. Remove "Original Soundtrack", "OST"
            import re
            stem = re.sub(r'(?i)original soundtrack|ost', '', stem)
            # 2. Remove leading track numbers "04 ", "04-"
            stem = re.sub(r'^\d+\s*[-_.]?\s*', '', stem)
            
            # 3. Replace separators
            stem = stem.replace('_', ' ').replace('-', ' ')
            
            # 4. Collapse spaces
            query = " ".join(stem.split())
        
        if not query or len(query) < 3:
            self.file_info.set_label("⚠ Could not guess song name. Please type it manually.")
            self.search_entry.grab_focus()
            return
            
        self.search_entry.set_text(query)
        self.on_search_metadata(self.search_entry)

    def on_search_entry_changed(self, entry):
        pass

    def on_search_submit(self, entry):
        self.on_search_metadata(entry)

    def on_search_metadata(self, entry):
        query = entry.get_text()
        if not query:
            return
            
        self.file_info.set_label(f"Searching for '{query}'...")
        threading.Thread(target=self._search_thread, args=(query,), daemon=True).start()

    def _search_thread(self, query):
        try:
            results = search_itunes(query, limit=1)
            GLib.idle_add(self._on_search_results, results)
        except Exception as e:
            print(f"Search error: {e}")
            GLib.idle_add(lambda: self.file_info.set_label("❌ Search Error"))

    def _on_search_results(self, results):
        if not results:
            self.file_info.set_label("❌ No results found")
            return
        
        result = results[0]
        title = result.get('track_name', 'Unknown')
        artist = result.get('artist_name', 'Unknown')
        self.file_info.set_label(f"✓ Found: {artist} - {title}")
        
        artwork_url = result.get('artwork_url')
        if artwork_url:
            threading.Thread(target=self._download_cover_thread, args=(artwork_url,), daemon=True).start()

    def _download_cover_thread(self, url):
        try:
            data = download_image(url)
            if data:
                with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as tmp:
                    tmp.write(data)
                    tmp_path = tmp.name
                GLib.idle_add(self._update_cover_preview, tmp_path)
        except Exception as e:
            print(f"Download cover error: {e}")

    def _update_cover_preview(self, path):
        self.cover_image_path = path
        try:
            # Create pixbuf for scaling
            import gi.repository.GdkPixbuf as GdkPixbuf
            pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 100, 100, True)
            self.cover_preview.set_from_pixbuf(pixbuf)
        except Exception:
            self.cover_preview.set_from_file(path) # Fallback

    def on_folder_selected(self, dialog, result):
        try:
            folder = dialog.select_folder_finish(result)
            if folder:
                self.selected_path = folder.get_path()
                self.folder_row.set_subtitle(self.selected_path)
                self.file_row.set_subtitle("Choose a single music file")
                self.file_info.set_label(f"Selected: {self.selected_path}")
                GLib.idle_add(self.scan_path_async)
        except Exception as e:
            print(f"Folder error: {e}")
            
    def on_file_selected(self, dialog, result):
        try:
            file = dialog.open_finish(result)
            if file:
                self.selected_path = file.get_path()
                self.file_row.set_subtitle(self.selected_path)
                self.folder_row.set_subtitle("Choose a directory")
                self.file_info.set_label(f"Selected: {self.selected_path}")
                
                # Force enable button immediately for single files
                self.file_count = 1
                self.upload_btn.set_sensitive(True)
                
                GLib.idle_add(self.scan_path_async)
                
                # Auto-fill search box if empty
                if not self.search_entry.get_text():
                    name = Path(self.selected_path).stem
                    cleaned = name.replace('_', ' ').replace('-', ' ')
                    self.search_entry.set_text(cleaned)
                    
        except Exception as e:
            print(f"File error: {e}")
    
    def scan_path_async(self):
        def scan_thread():
            try:
                uploader = UploadEngine(self.config)
                audio_files = uploader.scan_directory(self.selected_path)
                self.file_count = len(audio_files)
                GLib.idle_add(self.on_scan_complete, self.file_count)
            except Exception as e:
                GLib.idle_add(self.on_scan_error, str(e))
        threading.Thread(target=scan_thread, daemon=True).start()
    
    def on_scan_complete(self, count):
        if count > 0:
            self.file_info.set_label(f"✓ Found {count} audio files")
            self.upload_btn.set_sensitive(True)
        else:
            # Check if it's a single file that was rejected?
            if self.selected_path and Path(self.selected_path).is_file():
                 self.file_info.set_label("⚠ Warning: File might be unsupported. Try anyway?")
                 self.upload_btn.set_sensitive(True) # ENABLE IT ANYWAY
            else:
                 self.file_info.set_label("⚠ No audio files found in folder")
                 self.upload_btn.set_sensitive(True) # Keep enabled to let user try (maybe files are hidden?)
    
    def on_scan_error(self, error):
        self.file_info.set_label(f"❌ Error scanning: {error}")
        self.upload_btn.set_sensitive(False)
    
    def on_upload_clicked(self, button):
        # Relaxed check: Allow upload if path is selected, even if scan count is pending
        if not self.selected_path:
            return
        
        self.upload_btn.set_sensitive(False)
        self.cancel_btn.set_label("Cancel Upload")
        self.progress_box.set_visible(True)
        self.status_label.set_label("Preparing upload...")
        GLib.idle_add(self.upload_async)
    
    def upload_async(self):
        def upload_thread():
            try:
                uploader = UploadEngine(self.config)
                compress = self.compress_row.get_active()
                # Default parallel/bitrate since controls removed
                parallel = 4 
                bitrate = 320
                
                library = uploader.run(
                    self.selected_path,
                    compress=compress,
                    parallel=parallel,
                    bitrate=bitrate,
                    cover_image_path=self.cover_image_path,
                    auto_fetch=self.auto_fetch_row.get_active()
                )
                
                if library:
                    GLib.idle_add(self.on_upload_complete, len(library.tracks))
                else:
                    GLib.idle_add(self.on_upload_error, "No tracks were uploaded")
            except Exception as e:
                GLib.idle_add(self.on_upload_error, str(e))
        threading.Thread(target=upload_thread, daemon=True).start()
    
    def on_upload_complete(self, track_count):
        self.progress_bar.set_fraction(1.0)
        self.status_label.set_label(f"✅ Upload complete! {track_count} tracks.")
        self.cancel_btn.set_label("Done")
        self.upload_btn.set_visible(False)
    
    def on_upload_error(self, error):
        self.status_label.set_label(f"❌ Upload failed: {error}")
        self.cancel_btn.set_label("Close")
        self.upload_btn.set_sensitive(True)
        self.upload_btn.set_label("Retry")
