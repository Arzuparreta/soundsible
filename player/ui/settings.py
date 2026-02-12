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
    
    def __init__(self, parent, library_manager, on_theme_change=None, current_theme="default"):
        super().__init__()
        
        print(f"DEBUG: SettingsDialog.__init__ - on_theme_change parameter = {on_theme_change}")
        print(f"DEBUG: SettingsDialog.__init__ - current_theme parameter = {current_theme}")
        
        self.library_manager = library_manager
        self.on_theme_change = on_theme_change
        self.current_theme = current_theme
        
        print(f"DEBUG: SettingsDialog.__init__ - self.on_theme_change set to = {self.on_theme_change}")
        
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
        
        # Local Path Change (only if provider is LOCAL)
        if provider_name == "Unknown" and hasattr(self.library_manager, 'config'):
             # Double check provider type from config
             from shared.models import StorageProvider
             if self.library_manager.config.provider == StorageProvider.LOCAL:
                 provider_name = "Local Storage / NAS"
                 provider_row.set_subtitle(provider_name)
                 
                 path_row = Adw.ActionRow()
                 path_row.set_title("Library Path")
                 path_row.set_subtitle(self.library_manager.config.endpoint)
                 
                 change_btn = Gtk.Button(label="Change Folder")
                 change_btn.set_valign(Gtk.Align.CENTER)
                 change_btn.connect("clicked", self._on_change_local_folder)
                 path_row.add_suffix(change_btn)
                 cloud_group.add(path_row)
        
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
        
        # Danger Zone
        danger_group = Adw.PreferencesGroup()
        danger_group.set_title("Danger Zone")
        danger_group.set_description("Irreversible actions")
        
        nuke_row = Adw.ActionRow()
        nuke_row.set_title("Delete All Library Content")
        nuke_row.set_subtitle("Permanently delete all tracks from cloud and local storage")
        
        nuke_btn = Gtk.Button(label="Nuke Library")
        nuke_btn.set_valign(Gtk.Align.CENTER)
        nuke_btn.add_css_class("destructive-action") # This is often red in themes
        nuke_btn.connect("clicked", self._on_nuke_library)
        nuke_row.add_suffix(nuke_btn)
        danger_group.add(nuke_row)
        
        disconnect_row = Adw.ActionRow()
        disconnect_row.set_title("Disconnect Storage")
        disconnect_row.set_subtitle("Remove cloud configuration (local files stay safe)")
        
        disconnect_btn = Gtk.Button(label="Disconnect")
        disconnect_btn.set_valign(Gtk.Align.CENTER)
        disconnect_btn.connect("clicked", self._on_disconnect_storage)
        disconnect_row.add_suffix(disconnect_btn)
        danger_group.add(disconnect_row)
        
        page.add(danger_group)
        
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
        
        # Download Group
        download_group = Adw.PreferencesGroup()
        download_group.set_title("Downloads")
        
        quality_row = Adw.ComboRow()
        quality_row.set_title("Default Download Quality")
        quality_row.set_subtitle("Used by the embedded smart downloader")
        
        model = Gtk.StringList.new(["Standard (128k)", "High Quality (320k)", "Ultra (Best Source)"])
        quality_row.set_model(model)
        
        # Map quality strings to indices
        quality_map = {"standard": 0, "high": 1, "ultra": 2}
        current_quality = getattr(self.library_manager.config, 'quality_preference', 'high')
        quality_row.set_selected(quality_map.get(current_quality, 1))
        
        quality_row.connect("notify::selected", self._on_download_quality_changed)
        download_group.add(quality_row)
        
        page.add(download_group)
        
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
        scheme_combo.append("odst", "ODST")
        
        # Set to current theme (passed from main window)
        scheme_combo.set_active_id(self.current_theme)
        
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
    
    def _on_nuke_library(self, button):
        """Handle nuke library button click."""
        # Confirmation dialog
        dialog = Adw.MessageDialog(transient_for=self)
        dialog.set_heading("Permanently Delete All Content?")
        dialog.set_body("This will delete ALL music files from your cloud bucket AND your local cache. This action is IRREVERSIBLE.")
        dialog.add_response("cancel", "Cancel")
        dialog.add_response("nuke", "DELETE EVERYTHING")
        dialog.set_response_appearance("nuke", Adw.ResponseAppearance.DESTRUCTIVE)
        dialog.connect("response", self._on_nuke_response)
        dialog.present()
    
    def _on_nuke_response(self, dialog, response):
        """Handle nuke confirmation."""
        if response == "nuke":
            try:
                # Show some feedback if possible, or just do it
                success = self.library_manager.nuke_library()
                if success:
                    # Maybe close dialog and show toast? 
                    # For now just print and hope user sees the change in UI later
                    print("Library nuked successfully")
                else:
                    print("Failed to nuke library")
            except Exception as e:
                print(f"Error during nuke: {e}")
    
    def _on_disconnect_storage(self, button):
        """Handle disconnect button click."""
        dialog = Adw.MessageDialog(transient_for=self)
        dialog.set_heading("Disconnect Cloud Storage?")
        dialog.set_body("This will remove your cloud credentials and configuration. Your music files in the cloud will remain safe, but you will need to re-run setup to access them again.")
        dialog.add_response("cancel", "Cancel")
        dialog.add_response("disconnect", "Disconnect")
        dialog.set_response_appearance("disconnect", Adw.ResponseAppearance.DESTRUCTIVE)
        dialog.connect("response", self._on_disconnect_response)
        dialog.present()
        
    def _on_disconnect_response(self, dialog, response):
        """Handle disconnect confirmation."""
        if response == "disconnect":
            try:
                if self.library_manager.disconnect_storage(wipe_local=False):
                    print("Disconnected successfully. Please restart the application.")
                    # In a real app we might want to trigger a restart or return to onboarding
                else:
                    print("Failed to disconnect.")
            except Exception as e:
                print(f"Error during disconnect: {e}")
    
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
    
    def _on_change_local_folder(self, button):
        """Open folder chooser to change local storage path."""
        dialog = Gtk.FileDialog.new()
        dialog.set_title("Select New Library Root")
        
        def on_open_response(d, result):
            try:
                file = d.select_folder_finish(result)
                if file:
                    new_path = file.get_path()
                    print(f"Switching local storage to: {new_path}")
                    
                    if self.library_manager.config:
                        # 1. Update Config
                        self.library_manager.config.endpoint = new_path
                        # Ensure bucket is '.' for flat structure in new folder
                        self.library_manager.config.bucket = "."
                        
                        # 2. Save Config
                        from shared.constants import DEFAULT_CONFIG_DIR
                        config_path = Path(DEFAULT_CONFIG_DIR).expanduser() / "config.json"
                        with open(config_path, 'w') as f:
                            f.write(self.library_manager.config.to_json())
                            
                        # 3. Re-init Network/Provider
                        self.library_manager._init_network()
                        
                        # 4. Trigger Sync and Refresh
                        self.library_manager.sync_library()
                        if hasattr(self.library_manager, 'refresh_callback') and self.library_manager.refresh_callback:
                            self.library_manager.refresh_callback()
                            
                        # 5. Reload Settings page to show new path
                        # Simplified: just close and let user re-open or update label
                        self.close()
                        
            except Exception as e:
                print(f"Error changing local folder: {e}")

        dialog.select_folder(self, None, on_open_response)

    def _on_color_scheme_changed(self, combo):
        """Handle color scheme change."""
        scheme_id = combo.get_active_id()
        print(f"DEBUG: Settings._on_color_scheme_changed() called with scheme_id='{scheme_id}'")
        print(f"DEBUG: on_theme_change callback exists: {self.on_theme_change is not None}")
        if self.on_theme_change:
            print(f"DEBUG: Calling on_theme_change callback with '{scheme_id}'")
            self.on_theme_change(scheme_id)
        else:
            print(f"ERROR: on_theme_change callback is None!")

    def _on_download_quality_changed(self, row, pspec):
        """Handle default download quality change."""
        selected = row.get_selected()
        quality_map_inv = {0: "standard", 1: "high", 2: "ultra"}
        quality = quality_map_inv.get(selected, "high")
        
        if self.library_manager.config:
            self.library_manager.config.quality_preference = quality
            # Save config to disk
            from shared.constants import DEFAULT_CONFIG_DIR
            config_path = Path(DEFAULT_CONFIG_DIR).expanduser() / "config.json"
            with open(config_path, 'w') as f:
                f.write(self.library_manager.config.to_json())
            print(f"Default download quality updated to: {quality}")
