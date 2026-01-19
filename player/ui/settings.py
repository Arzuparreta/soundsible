"""
Settings dialog for the music player.

Provides configuration for storage, playback, and appearance.
"""

import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')
from gi.repository import Gtk, Adw, Gio
import os
from pathlib import Path


class SettingsDialog(Adw.PreferencesWindow):
    """Settings dialog using Adwaita preferences window."""
    
    def __init__(self, parent, library_manager):
        super().__init__()
        
        self.library_manager = library_manager
        self.set_transient_for(parent)
        self.set_modal(True)
        self.set_default_size(600, 500)
        
        # Create pages
        self._create_storage_page()
        self._create_playback_page()
        self._create_appearance_page()
    
    def _create_storage_page(self):
        """Create storage settings page."""
        page = Adw.PreferencesPage()
        page.set_title("Storage")
        page.set_icon_name("drive-harddisk-symbolic")
        
        # Cloud Storage Group
        cloud_group = Adw.PreferencesGroup()
        cloud_group.set_title("Cloud Storage")
        cloud_group.set_description("Your music files stored in the cloud")
        
        # Provider info
        provider_name = "Unknown"
        bucket_name = "Unknown"
        if hasattr(self.library_manager, 'provider'):
            provider = self.library_manager.provider
            # Try different attribute names for bucket
            if hasattr(provider, 'bucket_name'):
                bucket_name = provider.bucket_name
            elif hasattr(provider, 'bucket'):
                bucket_name = provider.bucket
            # Detect provider type
            provider_type = type(provider).__name__
            if "Cloudflare" in provider_type:
                provider_name = "Cloudflare R2"
            elif "Backblaze" in provider_type:
                provider_name = "Backblaze B2"
        
        provider_row = Adw.ActionRow()
        provider_row.set_title("Provider")
        provider_row.set_subtitle(provider_name)
        cloud_group.add(provider_row)
        
        bucket_row = Adw.ActionRow()
        bucket_row.set_title("Bucket Name")
        bucket_row.set_subtitle(bucket_name)
        cloud_group.add(bucket_row)
        
        # Storage usage - calculate on demand
        self.storage_row = Adw.ActionRow()
        self.storage_row.set_title("Cloud Storage Used")
        self.storage_row.set_subtitle("Click to calculate")
        
        calc_btn = Gtk.Button(label="Calculate")
        calc_btn.set_valign(Gtk.Align.CENTER)
        calc_btn.connect("clicked", self._on_calculate_storage)
        self.storage_row.add_suffix(calc_btn)
        
        cloud_group.add(self.storage_row)
        
        page.add(cloud_group)
        
        # Local Cache Group
        cache_group = Adw.PreferencesGroup()
        cache_group.set_title("Local Cache")
        cache_group.set_description("Downloaded files stored on your computer")
        
        # Cache location
        cache_path = "Not configured"
        if hasattr(self.library_manager, 'cache') and self.library_manager.cache:
            cache_path = str(self.library_manager.cache.cache_dir)
        
        location_row = Adw.ActionRow()
        location_row.set_title("Cache Location")
        location_row.set_subtitle(cache_path)
        cache_group.add(location_row)
        
        # Cache size
        cache_size = self._get_cache_size()
        size_row = Adw.ActionRow()
        size_row.set_title("Cache Size")
        size_row.set_subtitle(cache_size)
        cache_group.add(size_row)
        
        # Clear cache button
        clear_row = Adw.ActionRow()
        clear_row.set_title("Clear Cache")
        clear_btn = Gtk.Button(label="Clear")
        clear_btn.set_valign(Gtk.Align.CENTER)
        clear_btn.connect("clicked", self._on_clear_cache)
        clear_row.add_suffix(clear_btn)
        cache_group.add(clear_row)
        
        page.add(cache_group)
        self.add(page)
    
    def _create_playback_page(self):
        """Create playback settings page."""
        page = Adw.PreferencesPage()
        page.set_title("Playback")
        page.set_icon_name("media-playback-start-symbolic")
        
        # Audio Output Group
        audio_group = Adw.PreferencesGroup()
        audio_group.set_title("Audio Output")
        
        # Output device selector
        device_row = Adw.ActionRow()
        device_row.set_title("Output Device")
        device_row.set_subtitle("Default system output")
        
        # Note: MPV handles device selection automatically
        # Advanced users can configure via mpv.conf
        info_label = Gtk.Label(label="Managed by system")
        info_label.add_css_class("dim-label")
        device_row.add_suffix(info_label)
        
        audio_group.add(device_row)
        page.add(audio_group)
        self.add(page)
    
    def _create_appearance_page(self):
        """Create appearance settings page."""
        page = Adw.PreferencesPage()
        page.set_title("Appearance")
        page.set_icon_name("preferences-desktop-theme-symbolic")
        
        # Theme Group
        theme_group = Adw.PreferencesGroup()
        theme_group.set_title("Theme")
        
        # Color scheme
        scheme_row = Adw.ActionRow()
        scheme_row.set_title("Color Scheme")
        
        scheme_combo = Gtk.ComboBoxText()
        scheme_combo.append("default", "System")
        scheme_combo.append("light", "Light")
        scheme_combo.append("dark", "Dark")
        scheme_combo.append("odst", "odst")
        
        # Determine current selection logic could be complex (requires syncing back state)
        # For now, we defaulting UI to "odst" since we set it in main.py
        # Ideally we pass current theme in init.
        # Let's assume odst for now, or default.
        scheme_combo.set_active_id("odst")
        
        scheme_combo.connect("changed", self._on_color_scheme_changed)
        scheme_row.add_suffix(scheme_combo)
        
        theme_group.add(scheme_row)
        page.add(theme_group)
        
        # Typography Group
        typo_group = Adw.PreferencesGroup()
        typo_group.set_title("Typography")
        
        # Font size
        font_row = Adw.ActionRow()
        font_row.set_title("Font Size")
        font_row.set_subtitle("Requires app restart")
        
        font_combo = Gtk.ComboBoxText()
        font_combo.append("small", "Small")
        font_combo.append("normal", "Normal")
        font_combo.append("large", "Large")
        font_combo.set_active_id("normal")
        font_row.add_suffix(font_combo)
        
        typo_group.add(font_row)
        page.add(typo_group)
        self.add(page)
    
    def _get_cache_size(self):
        """Calculate cache directory size."""
        try:
            if not hasattr(self.library_manager, 'cache') or not self.library_manager.cache:
                return "No cache configured"
            
            cache_dir = Path(self.library_manager.cache.cache_dir)
            if not cache_dir.exists():
                return "0 MB"
            
            total_size = sum(f.stat().st_size for f in cache_dir.rglob('*') if f.is_file())
            size_mb = total_size / (1024 * 1024)
            
            if size_mb < 1:
                return f"{total_size / 1024:.1f} KB"
            elif size_mb < 1024:
                return f"{size_mb:.1f} MB"
            else:
                return f"{size_mb / 1024:.1f} GB"
        except Exception as e:
            return f"Error: {e}"
    
    def _on_clear_cache(self, button):
        """Handle clear cache button click."""
        if not hasattr(self.library_manager, 'cache') or not self.library_manager.cache:
            return
        
        # Confirmation dialog
        dialog = Adw.MessageDialog(transient_for=self)
        dialog.set_heading("Clear Cache?")
        dialog.set_body("This will delete all cached music files. They will be re-downloaded when needed.")
        dialog.add_response("cancel", "Cancel")
        dialog.add_response("clear", "Clear Cache")
        dialog.set_response_appearance("clear", Adw.ResponseAppearance.DESTRUCTIVE)
        dialog.connect("response", self._on_clear_cache_response)
        dialog.present()
    
    def _on_clear_cache_response(self, dialog, response):
        """Handle cache clear confirmation."""
        if response == "clear":
            try:
                self.library_manager.cache.clear_cache()
                print("Cache cleared successfully")
            except Exception as e:
                print(f"Failed to clear cache: {e}")
    
    def _on_calculate_storage(self, button):
        """Calculate bucket storage usage in background."""
        import threading
        from gi.repository import GLib
        
        # Disable button and show loading
        button.set_sensitive(False)
        self.storage_row.set_subtitle("Calculating...")
        
        def calculate():
            try:
                if hasattr(self.library_manager, 'provider'):
                    size_bytes = self.library_manager.provider.calculate_bucket_size()
                    size_mb = size_bytes / (1024 * 1024)
                    
                    if size_mb < 1024:
                        size_str = f"{size_mb:.1f} MB"
                    else:
                        size_str = f"{size_mb / 1024:.2f} GB"
                    
                    # Update UI on main thread
                    GLib.idle_add(self._update_storage_display, size_str, button)
                else:
                    GLib.idle_add(self._update_storage_display, "Provider not available", button)
            except Exception as e:
                GLib.idle_add(self._update_storage_display, f"Error: {e}", button)
        
        threading.Thread(target=calculate, daemon=True).start()
    
    def _update_storage_display(self, size_str, button):
        """Update storage display on main thread."""
        self.storage_row.set_subtitle(size_str)
        button.set_sensitive(True)
        return False
    
    def _on_color_scheme_changed(self, combo):
        """Handle color scheme change."""
        scheme_id = combo.get_active_id()
        if self.on_theme_change:
            self.on_theme_change(scheme_id)
