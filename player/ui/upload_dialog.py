"""
Music upload dialog for uploading audio files to cloud storage.
"""

import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')
from gi.repository import Gtk, Adw, GLib, Gio

from pathlib import Path
import threading
from setup_tool.uploader import UploadEngine
from setup_tool.audio import AudioProcessor


class UploadDialog(Adw.Window):
    """Dialog for uploading music files to cloud storage."""
    
    def __init__(self, config, **kwargs):
        super().__init__(**kwargs)
        
        self.config = config
        self.selected_path = None
        self.file_count = 0
        self.is_uploading = False
        
        self.set_title("Upload Music")
        self.set_default_size(600, 500)
        self.set_modal(True)
        
        # Main layout
        main_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.set_content(main_box)
        
        # Header
        header = Adw.HeaderBar()
        main_box.append(header)
        
        # Content
        content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=24)
        content.set_margin_top(24)
        content.set_margin_bottom(24)
        content.set_margin_start(24)
        content.set_margin_end(24)
        content.set_vexpand(True)
        
        # Title
        title = Gtk.Label(label="Upload Music to Cloud")
        title.add_css_class("title-2")
        content.append(title)
        
        # Folder selection
        folder_group = Adw.PreferencesGroup()
        folder_group.set_title("Select Music Source")
        
        # Folder row
        self.folder_row = Adw.ActionRow()
        self.folder_row.set_title("Select Folder")
        self.folder_row.set_subtitle("Choose a directory with music files")
        
        folder_btn = Gtk.Button(icon_name="folder-open-symbolic")
        folder_btn.set_valign(Gtk.Align.CENTER)
        folder_btn.set_tooltip_text("Select Folder")
        folder_btn.connect('clicked', self.on_select_folder)
        self.folder_row.add_suffix(folder_btn)
        folder_group.add(self.folder_row)
        
        # File row
        self.file_row = Adw.ActionRow()
        self.file_row.set_title("Select File")
        self.file_row.set_subtitle("Choose a single music file")
        
        # Use a more standard icon that is guaranteed to exist
        file_btn = Gtk.Button(icon_name="emblem-music-symbolic") 
        file_btn.set_valign(Gtk.Align.CENTER)
        file_btn.set_tooltip_text("Select File")
        file_btn.connect('clicked', self.on_select_file)
        self.file_row.add_suffix(file_btn)
        folder_group.add(self.file_row)
        
        content.append(folder_group)
        
        # File info label
        self.file_info = Gtk.Label(label="")
        self.file_info.add_css_class("dim-label")
        content.append(self.file_info)
        
        # Upload options
        options_group = Adw.PreferencesGroup()
        options_group.set_title("Upload Options")
        
        # Compress toggle
        self.compress_row = Adw.SwitchRow()
        self.compress_row.set_title("Convert FLAC/WAV to MP3")
        self.compress_row.set_subtitle("Reduce file size for faster uploads")
        self.compress_row.set_active(True)
        options_group.add(self.compress_row)
        
        # Bitrate
        self.bitrate_row = Adw.ActionRow()
        self.bitrate_row.set_title("MP3 Bitrate")
        self.bitrate_row.set_subtitle("320 kbps (High Quality)")
        
        self.bitrate_scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 128, 320, 32)
        self.bitrate_scale.set_value(320)
        self.bitrate_scale.set_draw_value(False)
        self.bitrate_scale.set_hexpand(True)
        self.bitrate_scale.set_size_request(150, -1) # Set min width
        self.bitrate_scale.connect('value-changed', self.on_bitrate_changed)
        
        self.bitrate_row.add_suffix(self.bitrate_scale)
        options_group.add(self.bitrate_row)
        
        # Parallel uploads
        self.parallel_row = Adw.ActionRow()
        self.parallel_row.set_title("Parallel Uploads")
        self.parallel_row.set_subtitle("4 threads")
        
        self.parallel_scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 1, 8, 1)
        self.parallel_scale.set_value(4)
        self.parallel_scale.set_draw_value(False)
        self.parallel_scale.set_hexpand(True)
        self.parallel_scale.set_size_request(150, -1) # Set min width
        self.parallel_scale.connect('value-changed', self.on_parallel_changed)
        
        self.parallel_row.add_suffix(self.parallel_scale)
        options_group.add(self.parallel_row)
        
        content.append(options_group)
        
        # Progress section (hidden initially)
        self.progress_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        self.progress_box.set_visible(False)
        
        self.progress_bar = Gtk.ProgressBar()
        self.progress_box.append(self.progress_bar)
        
        self.status_label = Gtk.Label(label="")
        self.status_label.add_css_class("dim-label")
        self.progress_box.append(self.status_label)
        
        content.append(self.progress_box)
        
        main_box.append(content)
        
        # Bottom buttons
        button_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        button_box.set_margin_top(12)
        button_box.set_margin_bottom(24)
        button_box.set_margin_start(24)
        button_box.set_margin_end(24)
        button_box.set_halign(Gtk.Align.END)
        
        self.cancel_btn = Gtk.Button(label="Cancel")
        self.cancel_btn.connect('clicked', lambda b: self.close())
        button_box.append(self.cancel_btn)
        
        self.upload_btn = Gtk.Button(label="Upload")
        self.upload_btn.add_css_class("suggested-action")
        self.upload_btn.set_sensitive(False)
        self.upload_btn.connect('clicked', self.on_upload_clicked)
        button_box.append(self.upload_btn)
        
        main_box.append(button_box)
    
    def on_bitrate_changed(self, scale):
        """Update bitrate subtitle."""
        value = int(scale.get_value())
        self.bitrate_row.set_subtitle(f"{value} kbps")
    
    def on_parallel_changed(self, scale):
        """Update parallel threads subtitle."""
        value = int(scale.get_value())
        self.parallel_row.set_subtitle(f"{value} threads")
    
    def on_select_folder(self, button):
        """Open folder chooser dialog."""
        dialog = Gtk.FileDialog()
        dialog.set_title("Select Music Folder")
        dialog.select_folder(parent=self, callback=self.on_folder_selected)
    
    def on_select_file(self, button):
        """Open file chooser dialog."""
        dialog = Gtk.FileDialog()
        dialog.set_title("Select Music File")
        
        # Add file filter
        filters = Gio.ListStore.new(Gtk.FileFilter)
        audio_filter = Gtk.FileFilter()
        audio_filter.set_name("Audio Files")
        # Add simpler mime types supported by GTK
        audio_filter.add_mime_type("audio/*")
        filters.append(audio_filter)
        dialog.set_filters(filters)
        
        dialog.open(parent=self, callback=self.on_file_selected)
    
    def on_folder_selected(self, dialog, result):
        """Handle folder selection."""
        try:
            folder = dialog.select_folder_finish(result)
            if folder:
                self.selected_path = folder.get_path()
                self.folder_row.set_subtitle(self.selected_path)
                self.file_row.set_subtitle("Choose a single music file") # Reset other
                
                # Scan folder for audio files
                self.file_info.set_label("Scanning folder...")
                GLib.idle_add(self.scan_path_async)
        except Exception as e:
            print(f"Folder selection cancelled or error: {e}")
            
    def on_file_selected(self, dialog, result):
        """Handle file selection."""
        try:
            file = dialog.open_finish(result)
            if file:
                self.selected_path = file.get_path()
                self.file_row.set_subtitle(self.selected_path)
                self.folder_row.set_subtitle("Choose a directory with music files") # Reset other
                
                # Scan (logic handles single file too)
                self.file_info.set_label("Checking file...")
                GLib.idle_add(self.scan_path_async)
        except Exception as e:
            print(f"File selection cancelled: {e}")
    
    def scan_path_async(self):
        """Scan path (folder or file) for audio files."""
        def scan_thread():
            try:
                # Create uploader to use scan_directory method
                uploader = UploadEngine(self.config)
                audio_files = uploader.scan_directory(self.selected_path)
                self.file_count = len(audio_files)
                
                GLib.idle_add(self.on_scan_complete, self.file_count)
            except Exception as e:
                GLib.idle_add(self.on_scan_error, str(e))
        
        thread = threading.Thread(target=scan_thread, daemon=True)
        thread.start()
        return False
    
    def on_scan_complete(self, count):
        """Update UI after scan completes."""
        if count > 0:
            self.file_info.set_label(f"✓ Found {count} audio files")
            self.upload_btn.set_sensitive(True)
        else:
            self.file_info.set_label("⚠ No audio files found")
            self.upload_btn.set_sensitive(False)
        return False
    
    def on_scan_error(self, error):
        """Handle scan error."""
        self.file_info.set_label(f"❌ Error scanning: {error}")
        self.upload_btn.set_sensitive(False)
        return False
    
    def on_upload_clicked(self, button):
        """Start upload process."""
        if not self.selected_path or self.file_count == 0:
            return
        
        # Disable buttons
        self.upload_btn.set_sensitive(False)
        self.cancel_btn.set_label("Cancel Upload")
        
        # Show progress
        self.progress_box.set_visible(True)
        self.status_label.set_label("Preparing upload...")
        
        # Start upload in background
        GLib.idle_add(self.upload_async)
    
    def upload_async(self):
        """Run upload in background thread."""
        def upload_thread():
            try:
                uploader = UploadEngine(self.config)
                
                # Get settings
                compress = self.compress_row.get_active()
                bitrate = int(self.bitrate_scale.get_value())
                parallel = int(self.parallel_scale.get_value())
                
                # Run upload
                library = uploader.run(
                    self.selected_path,
                    compress=compress,
                    parallel=parallel,
                    bitrate=bitrate
                )
                
                if library:
                    GLib.idle_add(self.on_upload_complete, len(library.tracks))
                else:
                    GLib.idle_add(self.on_upload_error, "No tracks were uploaded")
                    
            except Exception as e:
                GLib.idle_add(self.on_upload_error, str(e))
        
        thread = threading.Thread(target=upload_thread, daemon=True)
        thread.start()
        return False
    
    def on_upload_complete(self, track_count):
        """Handle upload completion."""
        self.progress_bar.set_fraction(1.0)
        self.status_label.set_label(f"✅ Upload complete! {track_count} tracks uploaded.")
        
        self.cancel_btn.set_label("Done")
        self.upload_btn.set_visible(False)
        return False
    
    def on_upload_error(self, error):
        """Handle upload error."""
        self.status_label.set_label(f"❌ Upload failed: {error}")
        
        self.cancel_btn.set_label("Close")
        self.upload_btn.set_sensitive(True)
        self.upload_btn.set_label("Retry")
        return False
