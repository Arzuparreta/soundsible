import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')
from gi.repository import Gtk, Adw, Gio, GObject, GLib, Gdk
from shared.constants import DEFAULT_CONFIG_DIR, DEFAULT_LIBRARY_PATH, DEFAULT_CACHE_DIR
from shared.models import PlayerConfig
from player.cover_manager import CoverFetchManager
from player.library import LibraryManager
from player.ui.library import LibraryView
from player.ui.settings import SettingsDialog
from player.engine import PlaybackEngine
from player.queue_manager import QueueManager
from player.ui.queue_view import QueueView
from player.favourites_manager import FavouritesManager
from player.ui.tab_view import TabView
from .volume_knob import VolumeKnob
from pathlib import Path
import os
import json

class MusicApp(Adw.Application):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        import sys
        print(f"DEBUG: sys.path: {sys.path}")
        self.connect('activate', self.on_activate)
        
        self.theme_provider = None
        self.current_theme = self._load_theme_preference()  # Load saved theme or default
        
        # Register actions
        self.create_actions()
    
    def create_actions(self):
        """Create application-level actions for menu."""
        # Setup wizard action
        setup_action = Gio.SimpleAction.new("setup-wizard", None)
        setup_action.connect("activate", self.on_setup_wizard)
        self.add_action(setup_action)
        
        # Upload music action
        upload_action = Gio.SimpleAction.new("upload-music", None)
        upload_action.connect("activate", self.on_upload_music)
        self.add_action(upload_action)

        # Download music action
        download_action = Gio.SimpleAction.new("download-music", None)
        download_action.connect("activate", self.on_download_music)
        self.add_action(download_action)
        
        # About action
        about_action = Gio.SimpleAction.new("about", None)
        about_action.connect("activate", self.on_about)
        self.add_action(about_action)
    
    def on_setup_wizard(self, action, param):
        """Show setup wizard."""
        if hasattr(self, 'win'):
            self.win.show_wizard()
    
    def on_upload_music(self, action, param):
        """Show music upload dialog."""
        if hasattr(self, 'win'):
            from player.ui.upload_dialog import UploadDialog
            
            config = self.win._load_config()
            if not config:
                # Show dialog to prompt setup
                dialog = Gtk.MessageDialog(
                    transient_for=self.win,
                    modal=True,
                    message_type=Gtk.MessageType.WARNING,
                    buttons=Gtk.ButtonsType.NONE,
                    text="Setup Required"
                )
                dialog.format_secondary_text(
                    "You need to configure your cloud storage before you can upload music.\n"
                    "Would you like to run the setup wizard now?"
                )
                dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
                dialog.add_button("Run Setup", Gtk.ResponseType.ACCEPT)
                
                # Style the setup button
                setup_btn = dialog.get_widget_for_response(Gtk.ResponseType.ACCEPT)
                if setup_btn:
                    setup_btn.add_css_class("suggested-action")
                
                def on_response(d, response):
                    d.destroy()
                    if response == Gtk.ResponseType.ACCEPT:
                        self.on_setup_wizard(action, param)

                dialog.connect('response', on_response)
                dialog.present()
                return
            
            dialog = UploadDialog(config=config, transient_for=self.win)
            dialog.present()
    
    def on_download_music(self, action, param):
        """Show music download dialog."""
        if hasattr(self, 'win'):
            from player.ui.download_dialog import DownloadDialog
            
            config = self.win._load_config()
            if not config:
                # Show dialog to prompt setup
                dialog = Gtk.MessageDialog(
                    transient_for=self.win,
                    modal=True,
                    message_type=Gtk.MessageType.WARNING,
                    buttons=Gtk.ButtonsType.NONE,
                    text="Setup Required"
                )
                dialog.format_secondary_text(
                    "You need to configure your cloud storage before you can download & push music.\n"
                    "Would you like to run the setup wizard now?"
                )
                dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
                dialog.add_button("Run Setup", Gtk.ResponseType.ACCEPT)
                
                # Style the setup button
                setup_btn = dialog.get_widget_for_response(Gtk.ResponseType.ACCEPT)
                if setup_btn:
                    setup_btn.add_css_class("suggested-action")
                
                def on_response(d, response):
                    d.destroy()
                    if response == Gtk.ResponseType.ACCEPT:
                        self.on_setup_wizard(action, param)

                dialog.connect('response', on_response)
                dialog.present()
                return

            dialog = DownloadDialog(transient_for=self.win)
            dialog.present()
    
    def on_about(self, action, param):
        """Show about dialog."""
        if hasattr(self, 'win'):
            about = Adw.AboutWindow(
                transient_for=self.win,
                application_name="Music Hub",
                application_icon="folder-music-symbolic",
                developer_name="Music Hub Team",
                version="1.0.0",
                website="https://github.com/yourusername/sh-music-hub",
                issue_url="https://github.com/yourusername/sh-music-hub/issues",
                license_type=Gtk.License.MIT_X11
            )
            about.present()
    
    def on_activate(self, app):
        # Load CSS
        css_provider = Gtk.CssProvider()
        css_path = os.path.join(os.path.dirname(__file__), 'style.css')
        css_provider.load_from_path(css_path)
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(), 
            css_provider, 
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        )
        
        # Load and apply saved theme preference
        self.set_theme(self.current_theme)
        
        self.win = MainWindow(application=app)
        self.win.present()
    
    def _load_theme_preference(self):
        """Load saved theme preference from preferences file."""
        prefs_file = Path(DEFAULT_CONFIG_DIR).expanduser() / "preferences.json"
        print(f"DEBUG: _load_theme_preference() - checking file: {prefs_file}")
        try:
            if prefs_file.exists():
                print(f"DEBUG: Preferences file exists, reading...")
                with open(prefs_file, 'r') as f:
                    prefs = json.load(f)
                    theme = prefs.get('theme', 'default')
                    print(f"DEBUG: Loaded theme from file: '{theme}'")
                    return theme
            else:
                print(f"DEBUG: Preferences file does not exist")
        except Exception as e:
            print(f"ERROR loading theme preference: {e}")
            import traceback
            traceback.print_exc()
        print(f"DEBUG: Returning default theme")
        return 'default'  # Default to system theme
    
    def _save_theme_preference(self, theme_name):
        """Save theme preference to preferences file."""
        prefs_file = Path(DEFAULT_CONFIG_DIR).expanduser() / "preferences.json"
        try:
            # Ensure config directory exists
            prefs_file.parent.mkdir(parents=True, exist_ok=True)
            
            # Load existing preferences or create new
            prefs = {}
            if prefs_file.exists():
                with open(prefs_file, 'r') as f:
                    prefs = json.load(f)
            
            # Update theme preference
            prefs['theme'] = theme_name
            
            # Save preferences
            with open(prefs_file, 'w') as f:
                json.dump(prefs, f, indent=2)
            
            print(f"DEBUG: Saved theme preference: {theme_name}")
        except Exception as e:
            print(f"Error saving theme preference: {e}")
    
    def set_theme(self, theme_name):
        """Set application theme."""
        print(f"DEBUG: set_theme() called with theme_name='{theme_name}'")
        
        self.current_theme = theme_name  # Track current theme
        style_manager = Adw.StyleManager.get_default()
        display = Gdk.Display.get_default()
        
        # Defensive check: ensure display is valid
        if display is None:
            print(f"ERROR: Display is None! Cannot set theme. This shouldn't happen.")
            return
        
        print(f"DEBUG: Display is valid, proceeding with theme '{theme_name}'")

        # Remove existing theme provider if any
        if self.theme_provider:
            try:
                Gtk.StyleContext.remove_provider_for_display(display, self.theme_provider)
                print(f"DEBUG: Removed previous theme provider")
            except Exception as e:
                print(f"WARNING: Failed to remove previous theme provider: {e}")
            self.theme_provider = None

        # Apply theme based on selection
        try:
            if theme_name == "light":
                print(f"DEBUG: Applying LIGHT theme")
                style_manager.set_color_scheme(Adw.ColorScheme.FORCE_LIGHT)
                # Load light theme CSS
                self.theme_provider = Gtk.CssProvider()
                css_path = os.path.join(os.path.dirname(__file__), 'theme_light.css')
                print(f"DEBUG: Loading CSS from: {css_path}")
                self.theme_provider.load_from_path(css_path)
                Gtk.StyleContext.add_provider_for_display(
                    display, 
                    self.theme_provider, 
                    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1
                )
                print(f"DEBUG: Light theme CSS loaded and applied successfully")
                
            elif theme_name == "dark":
                print(f"DEBUG: Applying DARK theme")
                style_manager.set_color_scheme(Adw.ColorScheme.FORCE_DARK)
                # Load dark theme CSS
                self.theme_provider = Gtk.CssProvider()
                css_path = os.path.join(os.path.dirname(__file__), 'theme_dark.css')
                print(f"DEBUG: Loading CSS from: {css_path}")
                self.theme_provider.load_from_path(css_path)
                Gtk.StyleContext.add_provider_for_display(
                    display, 
                    self.theme_provider, 
                    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1
                )
                print(f"DEBUG: Dark theme CSS loaded and applied successfully")
                
            elif theme_name == "odst":
                print(f"DEBUG: Applying ODST theme")
                style_manager.set_color_scheme(Adw.ColorScheme.FORCE_DARK)
                # Load ODST theme CSS
                self.theme_provider = Gtk.CssProvider()
                css_path = os.path.join(os.path.dirname(__file__), 'theme_odst.css')
                print(f"DEBUG: Loading CSS from: {css_path}")
                self.theme_provider.load_from_path(css_path)
                Gtk.StyleContext.add_provider_for_display(
                    display, 
                    self.theme_provider, 
                    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1
                )
                print(f"DEBUG: ODST theme CSS loaded and applied successfully")
                
            else:  # "default" or any other value
                print(f"DEBUG: Applying DEFAULT (system) theme")
                style_manager.set_color_scheme(Adw.ColorScheme.DEFAULT)
                print(f"DEBUG: System theme applied successfully")
                
        except Exception as e:
            print(f"ERROR: Failed to apply theme '{theme_name}': {e}")
            import traceback
            traceback.print_exc()
            return
        
        # Save theme preference
        print(f"DEBUG: Calling _save_theme_preference('{theme_name}')")
        self._save_theme_preference(theme_name)



class MainWindow(Adw.ApplicationWindow):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        
        print("DEBUG: MainWindow initializing...")
        self.set_title("Music Hub")
        self.set_default_size(1000, 700)
        
        # Queue Manager
        print("DEBUG: Initializing QueueManager...")
        self.queue_manager = QueueManager()
        print("DEBUG: QueueManager initialized.")
        
        # Favourites Manager
        print("DEBUG: Initializing FavouritesManager...")
        self.favourites_manager = FavouritesManager()
        print("DEBUG: FavouritesManager initialized.")
        
        # Audio Engine
        print("DEBUG: Initializing PlaybackEngine...")
        self.engine = PlaybackEngine(queue_manager=self.queue_manager)
        print("DEBUG: PlaybackEngine initialized.")
        self.engine.set_state_change_callback(self.on_player_state_change)
        self.engine.add_track_end_callback(self.on_track_ended)
        self.engine.set_track_load_callback(self.play_track)  # For auto-play from queue
        
        
        # MPRIS Integration (optional - requires mpris_server package)
        try:
            print("DEBUG: Initializing MPRIS...")
            from player.mpris import MusicHubMpris
            from mpris_server import Server
            
            self.mpris = MusicHubMpris(self.engine, self)
            self.mpris_server = Server('MusicHub', adapter=self.mpris)
            self.mpris_server.publish()
            print("✓ MPRIS integration enabled (media keys available)")
        except ImportError as e:
            print(f"ℹ MPRIS integration disabled (install python-mpris-server for media key support)")
            self.mpris = None
        except Exception as e:
            print(f"⚠ Failed to publish MPRIS: {e}")
            self.mpris = None
        
        # Main Layout
        main_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.set_content(main_box)
        
        # Header Bar
        header = Adw.HeaderBar()
        self.title_widget = Adw.WindowTitle(title="Music Hub", subtitle="Local Library")
        header.set_title_widget(self.title_widget)
        main_box.append(header)
        
        # Settings action
        settings_action = Gio.SimpleAction.new("settings", None)
        settings_action.connect("activate", self._on_settings_clicked)
        self.add_action(settings_action)
        
        
        # Settings menu button (right side)
        menu_button = Gtk.MenuButton()
        menu_button.set_icon_name("open-menu-symbolic")
        menu = Gio.Menu()
        
        # Setup section
        setup_section = Gio.Menu()
        setup_section.append("Setup Wizard", "app.setup-wizard")
        setup_section.append("Upload Local Files to Cloud", "app.upload-music")
        setup_section.append("Download & Push (Smart)", "app.download-music")
        menu.append_section(None, setup_section)
        
        # Settings section
        settings_section = Gio.Menu()
        settings_section.append("Settings", "win.settings")
        menu.append_section(None, settings_section)
        
        # About section
        about_section = Gio.Menu()
        about_section.append("About", "app.about")
        menu.append_section(None, about_section)
        
        menu_button.set_menu_model(menu)
        header.pack_end(menu_button)


        
        # Playback controls container (Bottom bar)
        # We need to restructure this to have: [Cover] [Title/Artist] [Controls] [Volume]
        # Current structure seems to be just buttons. Let's inspect where this is added.
        
        # NOTE: The view above shows `player_container` having play button and progress bar. 
        # But earlier I thought it was `playback_box`.
        
        # Let's look at lines 150-174 in the view.
        # It adds `play_btn` and `progress_scale` to `player_container`.
        # This seems to be a reliable place.
        
        # Revamped Layout:
        # [Image] [Col: Title, Artist] [Space] [Prev] [Play] [Next] [Space] [Progress]
        
        # Let's rebuild the container content carefully.
        
        # Player Control Bar (Top)
        player_container = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        player_container.add_css_class("toolbar")
        player_container.set_spacing(8)
        
        # 1. Cover Art (clickable)
        self.cover_art = Gtk.Image()
        self.cover_art.set_pixel_size(48)
        self.cover_art.set_size_request(48, 48)
        self.cover_art.add_css_class("card")
        self.cover_art.set_from_icon_name("emblem-music-symbolic")
        self.cover_art.set_margin_end(12)
        self.cover_art.set_visible(False)  # Hide initially when no music playing
        
        # Make cover art clickable
        cover_click = Gtk.GestureClick()
        cover_click.connect("released", self._on_cover_clicked)
        self.cover_art.add_controller(cover_click)
        
        player_container.append(self.cover_art)
        
        # 2. Track Info
        info_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        info_box.set_valign(Gtk.Align.CENTER)
        info_box.set_margin_end(12)
        
        # ScrolledWindow for Title (Marquee)
        self.title_scroll = Gtk.ScrolledWindow()
        self.title_scroll.set_policy(Gtk.PolicyType.EXTERNAL, Gtk.PolicyType.NEVER)
        self.title_scroll.set_min_content_width(50) # Allow shrinking significantly
        self.title_scroll.set_max_content_width(200) # Cap growth
        self.title_scroll.set_propagate_natural_width(True)
        
        self.title_label = Gtk.Label(label="")
        self.title_label.add_css_class("player-title")
        self.title_label.set_halign(Gtk.Align.START)
        # No ellipsize, allow full width for scrolling
        
        self.title_scroll.set_child(self.title_label)
        
        self.artist_label = Gtk.Label(label="")
        self.artist_label.add_css_class("caption")
        self.artist_label.set_halign(Gtk.Align.START)
        self.artist_label.set_ellipsize(3)
        self.artist_label.set_max_width_chars(25)
        
        info_box.append(self.title_scroll)
        info_box.append(self.artist_label)
        player_container.append(info_box)

        self._marquee_source = None
        self._marquee_pos = 0
        self._marquee_pause = 0

        # 3. Progress Bar (Scale) - Moved Left
        self.progress_scale = Gtk.Scale(orientation=Gtk.Orientation.HORIZONTAL)
        self.progress_scale.set_size_request(150, -1) # Ensure minimum usable width matches user request
        self.progress_scale.set_draw_value(False)
        self.progress_scale.set_range(0, 100) # Default, updated on play
        self.progress_scale.set_hexpand(True) # Fill remaining space
        self.progress_scale.set_valign(Gtk.Align.CENTER)
        self.progress_scale.set_margin_start(12)
        self.progress_scale.set_margin_end(5)
        self.progress_scale.add_css_class("seek-bar")
        self.progress_scale.connect('value-changed', self.on_seek)
        player_container.append(self.progress_scale)

        # Time Label
        self.time_label = Gtk.Label(label="0:00 / 0:00")
        self.time_label.add_css_class("numeric")
        self.time_label.set_margin_start(5)
        self.time_label.set_margin_end(5)
        self.time_label.set_valign(Gtk.Align.CENTER)
        player_container.append(self.time_label)

        # 4. Playback Controls - Moved Right
        
        # Previous
        self.prev_btn = Gtk.Button(icon_name="media-skip-backward-symbolic")
        self.prev_btn.add_css_class("circular")
        self.prev_btn.set_valign(Gtk.Align.CENTER)
        self.prev_btn.connect('clicked', self.play_previous)
        player_container.append(self.prev_btn)

        # Play/Pause
        self.play_btn = Gtk.Button(icon_name="media-playback-start-symbolic")
        self.play_btn.add_css_class("circular")
        self.play_btn.add_css_class("play-button")
        self.play_btn.set_valign(Gtk.Align.CENTER)
        self.play_btn.connect('clicked', self.on_play_toggle)
        player_container.append(self.play_btn)
        
        # Next
        self.next_btn = Gtk.Button(icon_name="media-skip-forward-symbolic")
        self.next_btn.add_css_class("circular")
        self.next_btn.set_valign(Gtk.Align.CENTER)
        self.next_btn.connect('clicked', self.play_next)
        player_container.append(self.next_btn)
        
        # 5. Volume Knob
        self.volume_knob = VolumeKnob(initial_value=100.0)
        self.volume_knob.set_margin_start(8)
        self.volume_knob.set_margin_end(8)
        self.volume_knob.connect('value-changed', self.on_volume_changed)
        player_container.append(self.volume_knob)
        
        main_box.append(player_container)

        # Content Area (Split View)
        # Check for config and show wizard if needed
        config = self._load_config()
        if config:
            self._init_player_ui(main_box, config)
        else:
            # No config - show setup wizard
            self._show_first_run_wizard()
        
        # Connect Time Update
        self.engine.set_time_update_callback(self.on_time_update)
        self._seeking = False
        
        # Poll engine state to update button icon (simple fix)
        GLib.timeout_add(250, self._poll_engine_state)

    def _on_settings_clicked(self, action, param):
        """Show settings dialog."""
        print(f"DEBUG: _on_settings_clicked - self.application = {self.application}")
        print(f"DEBUG: _on_settings_clicked - self.application.set_theme = {self.application.set_theme}")
        print(f"DEBUG: _on_settings_clicked - self.application.current_theme = {self.application.current_theme}")
        dialog = SettingsDialog(
            parent=self, 
            library_manager=self.lib_manager, 
            on_theme_change=self.application.set_theme,
            current_theme=self.application.current_theme
        )
        print(f"DEBUG: Created SettingsDialog, on_theme_change = {dialog.on_theme_change}")
        dialog.present()


    def on_player_state_change(self, state):
        """Callback from engine (thread safe wrapper)."""
        GLib.idle_add(self._update_ui_state, state)

    def on_track_ended(self):
        """Callback from engine when track finishes."""
        # Stop engine to reset state and update UI (run on main thread)
        def _stop_safe():
            print("DEBUG: Executing engine.stop() on main thread")
            self.engine.stop()
            return False
            
        print("DEBUG: Scheduling engine.stop() via GLib.idle_add")
        GLib.idle_add(_stop_safe)

    def on_play_toggle(self, button):
        if self.engine.is_playing:
            self.engine.pause()
            self.play_btn.set_icon_name("media-playback-start-symbolic")
        else:
            self.play_btn.set_icon_name("media-playback-pause-symbolic")

            if self.engine.current_track:
                 self.engine.pause() # Resume
            else:
                 # Try to play the first track if available
                 tracks = self.lib_manager.get_all_tracks()
                 if tracks:
                     print("Starting playback from first track.")
                     self.play_track(tracks[0])

    def on_seek(self, scale):
        # Determine if this value change is from user or automated
        # Simplest way: check if generic 'state' flags (GTK3 had event check, GTK4 assumes interaction if focus?)
        # For simplicity, we might just seek. 
        # But to prevent loops, we need a flag that we set during auto-update
        if self._seeking:
            return
            
        value = scale.get_value()
        # We need duration to know if this is valid? 
        # Actually Scale is absolute if we set range
        if self.engine.current_track:
             self.engine.seek(value)

    def on_volume_changed(self, knob, value):
        """Handle volume knob changes."""
        self.engine.set_volume(int(value))


    def on_time_update(self, time):
        """Callback from engine when playback time updates."""
        # Schedule UI update on main thread
        GLib.idle_add(self._update_scale_safe, time)

    def _format_time(self, seconds):
        if seconds is None:
            return "0:00"
        seconds = int(seconds)
        m = seconds // 60
        s = seconds % 60
        return f"{m}:{s:02d}"

    def _marquee_tick(self):
        """Handle text scrolling for long titles."""
        adj = self.title_scroll.get_hadjustment()
        upper = adj.get_upper()
        page_size = adj.get_page_size()
        
        if upper <= page_size:
            # No scrolling needed
            return True # Keep running to check if resized
            
        if self._marquee_pause > 0:
            self._marquee_pause -= 1
            return True
            
        # Scroll
        self._marquee_pos += 2 # px per tick
        
        if self._marquee_pos > (upper - page_size):
            # Reached end
            self._marquee_pause = 20 # Pause at end
            self._marquee_pos = 0 # Reset to start (or could implement bounce/loop)
            adj.set_value(0) # Snap back for now (looping is cleaner but harder with adj)
        else:
            adj.set_value(self._marquee_pos)
            
        return True

    def _update_scale_safe(self, time):
        """Update progress scale on main thread (thread-safe)."""
        self._seeking = True
        self.progress_scale.set_value(time)
        
        # Update time label
        total = self.progress_scale.get_adjustment().get_upper()
        
        t_str = f"{self._format_time(time)} / {self._format_time(total)}"
        self.time_label.set_text(t_str)
        
        self._seeking = False
        return False  # Remove callback from idle queue to prevent memory leak

    def play_track(self, track):
        """Called when a track is double-clicked in the library."""
        print(f"Requesting play for: {track.title}")
        url = self.lib_manager.get_track_url(track)
        if url:
             self.engine.play(url, track)
             
             # Show cover art and update labels
             self.cover_art.set_visible(True)
             self.title_label.set_text(track.title)
             self.artist_label.set_text(track.artist)
             
             self.title_widget.set_subtitle(f"Playing: {track.title}")
             
             # Start/Reset Marquee
             if self._marquee_source:
                 GLib.source_remove(self._marquee_source)
             
             self._marquee_pos = 0
             self._marquee_pause = 20 # Initial pause (2s at 100ms)
             self._marquee_source = GLib.timeout_add(100, self._marquee_tick)
             # Wait for MPV to load and get actual duration
             GLib.timeout_add(100, self._update_duration_range, track)
             # Start background download to cache for cover art
             self._cache_track_async(track)
             # Try to update cover art (will retry if not cached yet)
             self.update_cover_art(track)
        else:
             print("Error: Could not resolve URL for track.")
    
    def _cache_track_async(self, track):
        """Download track to cache in background thread."""
        import threading
        def download_to_cache():
            try:
                # Check if already cached
                if self.lib_manager.cache:
                    cached = self.lib_manager.cache.get_cached_path(track.id)
                    if cached:
                        print(f"DEBUG: Track already cached at {cached}")
                        return
                    
                    # Download to cache
                    print(f"DEBUG: Starting background download to cache for: {track.title}")
                    remote_key = f"tracks/{track.id}.{track.format}"
                    
                    import tempfile
                    import os
                    # Download to temp first
                    fd, temp_path = tempfile.mkstemp(suffix=f".{track.format}")
                    os.close(fd)
                    
                    if self.lib_manager.provider.download_file(remote_key, temp_path):
                        # Add to cache
                        cached_path = self.lib_manager.cache.add_to_cache(track.id, temp_path, move=True)
                        print(f"DEBUG: Track cached successfully at {cached_path}")
                        # Trigger cover update now that file is cached
                        GLib.idle_add(self.update_cover_art, track, 0)
                    else:
                        print(f"DEBUG: Failed to download track for caching")
                        os.remove(temp_path)
            except Exception as e:
                print(f"DEBUG: Cache download failed: {e}")
                import traceback
                traceback.print_exc()
        
        threading.Thread(target=download_to_cache, daemon=True).start()
    
    def _update_duration_range(self, track):
        """Update progress bar range after track loads in MPV."""
        duration = self.engine.get_duration()
        if duration and duration > 0:
            self.progress_scale.set_range(0, duration)
        elif track.duration:
            self.progress_scale.set_range(0, track.duration)
        else:
            self.progress_scale.set_range(0, 300)  # Fallback
            
        # Update time label with new duration
        total = self.progress_scale.get_adjustment().get_upper()
        current = self.progress_scale.get_value()
        self.time_label.set_text(f"{self._format_time(current)} / {self._format_time(total)}")
        
        return False  # Remove from timeout queue
    
    def update_cover_art(self, track, retry_count=0):
        """Extract and display cover art for the given track."""
        try:
            from setup_tool.audio import AudioProcessor
            from gi.repository import GdkPixbuf
            import tempfile
            import os
            
            print(f"DEBUG: update_cover_art called for: {track.title} (attempt {retry_count + 1})")
            
            # Get local file path (from cache or download)
            local_path = None
            
            # Try cache first
            if self.lib_manager.cache:
                cached = self.lib_manager.cache.get_cached_path(track.id)
                print(f"DEBUG: Cached path result: {cached}")
                if cached and os.path.exists(cached):
                    local_path = cached
                    print(f"DEBUG: Using cached file: {local_path}")
            
            if not local_path:
                # File not cached yet, retry after a delay (max 3 attempts)
                if retry_count < 3:
                    print(f"DEBUG: File not cached yet, will retry in 2 seconds... (attempt {retry_count + 1}/3)")
                    GLib.timeout_add(2000, self._retry_cover_update, track, retry_count + 1)
                else:
                    print("DEBUG: Max retries reached, cache not working. Showing default icon.")
                    # Fallback: Trigger online fetch
                    self._fetch_online_cover(track)
                    
                self.cover_art.set_from_icon_name("emblem-music-symbolic")
                return
            
            # Check Local Cover Cache FIRST (Smart Fetch Result)
            covers_dir = os.path.join(os.path.expanduser(DEFAULT_CACHE_DIR), "covers")
            local_cover_path = os.path.join(covers_dir, f"{track.id}.jpg")
            
            if os.path.exists(local_cover_path):
                print(f"DEBUG: Found locally cached cover: {local_cover_path}")
                try:
                    pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
                        local_cover_path, 48, 48, True
                    )
                    self.cover_art.set_from_pixbuf(pixbuf)
                    return # Done!
                except Exception as e:
                    print(f"DEBUG: Failed to load cached cover: {e}")

            # Extract cover art from file
            print(f"DEBUG: Extracting cover from: {local_path}")
            cover_data = AudioProcessor.extract_cover_art(local_path)
            
            if cover_data:
                print(f"DEBUG: Cover data extracted, size: {len(cover_data)} bytes")
                # Save to temp file and load into GdkPixbuf
                with tempfile.NamedTemporaryFile(delete=False, suffix='.jpg') as tmp:
                    tmp.write(cover_data)
                    tmp_path = tmp.name
                
                try:
                    # Load and scale image
                    pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
                        tmp_path, 48, 48, True
                    )
                    self.cover_art.set_from_pixbuf(pixbuf)

                    print("DEBUG: Cover art displayed successfully!")
                finally:
                    os.remove(tmp_path)
            else:
                # No cover found, use default
                print("DEBUG: No cover data found in file")
                self.cover_art.set_from_icon_name("emblem-music-symbolic")
                
                # Fallback: Trigger online fetch
                self._fetch_online_cover(track)
                
                
        except Exception as e:
            print(f"DEBUG: Failed to update cover art: {e}")
            if "No cover data" not in str(e):
                import traceback
                traceback.print_exc()
            self.cover_art.set_from_icon_name("emblem-music-symbolic")

            # Fallback: Trigger online fetch if not found locally
            self._fetch_online_cover(track)
    
    def _fetch_online_cover(self, track):
        """Fetch cover art using centralized manager."""
        def on_fetched(path):
             if self.engine.current_track and self.engine.current_track.id == track.id:
                  GLib.idle_add(self.update_cover_art, track)
                  
        CoverFetchManager.get_instance().request_cover(track, callback=on_fetched)

    
    def _on_cover_clicked(self, gesture, n_press, x, y):
        """Handle click on cover art - show larger view."""
        if self.engine.current_track:
            self._show_cover_viewer(self.engine.current_track)
    
    def _show_cover_viewer(self, track):
        """Show cover art in a larger dialog."""
        try:
            from setup_tool.audio import AudioProcessor
            from gi.repository import GdkPixbuf
            import tempfile
            import os
            
            # Create dialog immediately so user sees something happening
            # Create dialog
            dialog = Adw.Window()
            dialog.set_transient_for(self)
            dialog.set_modal(True)
            dialog.set_title(f"{track.title}")
            dialog.set_default_size(350, 420) # Increased height slightly for header
            
            # Add ESC key handler
            key_controller = Gtk.EventControllerKey()
            key_controller.connect("key-pressed", lambda ctrl, keyval, keycode, state: 
                dialog.close() if keyval == Gdk.KEY_Escape else False)
            dialog.add_controller(key_controller)
            
            # Cleanup sync ref on close
            def on_dialog_close(d):
                pass
            dialog.connect("close-request", on_dialog_close)
            
            # Wrapper for HeaderBar + Content
            window_content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
            dialog.set_content(window_content)
            
            # Header Bar (Provides Title + Close Button on Top Right)
            header = Adw.HeaderBar()
            header.set_show_end_title_buttons(True)
            window_content.append(header)
            
            # Create content with proper layout
            main_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
            main_box.set_margin_start(12)
            main_box.set_margin_end(12)
            main_box.set_margin_top(0) # Header handles top spacing
            main_box.set_margin_bottom(12)
            window_content.append(main_box)
            
            # Image container
            image = Gtk.Picture()
            image.set_can_shrink(True)
            image.set_content_fit(Gtk.ContentFit.CONTAIN)
            image.set_vexpand(True)
            image.set_hexpand(True)
            main_box.append(image)
            
            # Loading/Status overlay (Stack)
            # For simplicity using just the image widget, if it fails we show icon.

            # Info label
            info = Gtk.Label()
            info.set_markup(f"<b>{track.title}</b>\n{track.artist}")
            info.set_vexpand(False)
            main_box.append(info)
            
            # Bottom controls bar - Use CenterBox to center playback controls
            controls_bar = Gtk.CenterBox()
            controls_bar.set_vexpand(False)
            
            # Close button (Start Widget) - REMOVED (Moved to HeaderBar)
            # close_btn = Gtk.Button(label="Close") ...
            
            # Playback controls (Center Widget)
            playback_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
            # ... (playback buttons added to playback_box below) ...
            
            # Note: We need to reconstruct playback_box here to append it correctly
            # But wait, looking at the code flow, playback_box is filled line by line.
            # I will define it here.
            
            # Prev Button
            prev_btn = Gtk.Button(icon_name="media-skip-backward-symbolic")
            prev_btn.add_css_class("flat")
            prev_btn.connect("clicked", self.play_previous)
            playback_box.append(prev_btn)
            
            # Play/Pause Button (Logic simplified)
            play_pause_btn = Gtk.Button()
            play_pause_btn.add_css_class("flat")
            play_pause_btn.add_css_class("large-button")
            
            # Initial icon
            if self.engine.is_playing:
                play_pause_btn.set_icon_name("media-playback-pause-symbolic")
            else:
                play_pause_btn.set_icon_name("media-playback-start-symbolic")
                
            def toggle_with_update(btn):
                self.on_play_toggle(btn)
                # Update icon immediately based on resulting state
                if self.engine.is_playing:
                     play_pause_btn.set_icon_name("media-playback-pause-symbolic")
                else:
                     play_pause_btn.set_icon_name("media-playback-start-symbolic")
            
            # Also poll/update periodically
            def _update_mini_player_button(dlg):
                if not dlg.is_visible(): return False
                if self.engine.is_playing:
                     play_pause_btn.set_icon_name("media-playback-pause-symbolic")
                else:
                     play_pause_btn.set_icon_name("media-playback-start-symbolic")
                return True
            
            if self.engine.is_playing:
                GLib.timeout_add(100, lambda: _update_mini_player_button(dialog))
            
            play_pause_btn.connect("clicked", toggle_with_update)
            playback_box.append(play_pause_btn)
            
            # Next Button
            next_btn = Gtk.Button(icon_name="media-skip-forward-symbolic")
            next_btn.add_css_class("flat")
            next_btn.connect("clicked", self.play_next)
            playback_box.append(next_btn)
            
            controls_bar.set_center_widget(playback_box)
            
            # Volume control (End Widget)
            volume_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
            
            # Use VolumeKnob instead of Scale
            self.mini_volume_knob = VolumeKnob(initial_value=self.volume_knob.get_value())
            # Reduce size to make bar shorter
            self.mini_volume_knob.set_size_request(28, 28) 
            self.mini_volume_knob.set_margin_start(4)
            self.mini_volume_knob.set_margin_end(4)
            
            def on_mini_vol_changed(k, v):
                # Update main knob
                if abs(self.volume_knob.get_value() - v) > 0.1:
                    self.volume_knob.set_value(v)
            
            self.mini_volume_knob.connect("value-changed", on_mini_vol_changed)
            volume_box.append(self.mini_volume_knob)
            
            controls_bar.set_end_widget(volume_box)
            
            main_box.append(controls_bar)
            
            # Now try to load the cover art asynchronously
            def load_cover_task():
                try:
                    # Check Smart Cache FIRST
                    covers_dir = os.path.join(os.path.expanduser(DEFAULT_CACHE_DIR), "covers")
                    local_cover_path = os.path.join(covers_dir, f"{track.id}.jpg")
                    
                    if os.path.exists(local_cover_path):
                         GLib.idle_add(self._update_viewer_image, image, local_cover_path)
                         return

                    local_path = None
                    if self.lib_manager.cache:
                        cached = self.lib_manager.cache.get_cached_path(track.id)
                        if cached and os.path.exists(cached):
                            local_path = cached
                    
                    if not local_path:
                        # Schedule update to show "No File" or trigger download?
                        # For now, just show default
                        GLib.idle_add(self._set_viewer_default, image, "Track not cached yet")
                        return

                    cover_data = AudioProcessor.extract_cover_art(local_path)
                    if not cover_data:
                        GLib.idle_add(self._set_viewer_default, image, "No cover art found")
                        return
                    
                    # Save to temp file and load
                    with tempfile.NamedTemporaryFile(delete=False, suffix='.jpg') as tmp:
                        tmp.write(cover_data)
                        tmp_path = tmp.name
                    
                    GLib.idle_add(self._update_viewer_image, image, tmp_path)
                    
                except Exception as e:
                    print(f"Error loading cover for viewer: {e}")
                    GLib.idle_add(self._set_viewer_default, image, "Error loading cover")

            # Show dialog first
            dialog.present()
            
            # Then start loading
            import threading
            threading.Thread(target=load_cover_task, daemon=True).start()
                
        except Exception as e:
            print(f"Failed to show cover viewer: {e}")
            import traceback
            traceback.print_exc()

    def _update_viewer_image(self, image_widget, path):
        """Update the picture widget with file path (on main thread)."""
        try:
             # Paintable from file
             file = Gio.File.new_for_path(path)
             texture = Gdk.Texture.new_from_file(file)
             image_widget.set_paintable(texture)
             # Remove temp file? 
             # It's tricky with async loading, might need cleanup later.
             # For now we leak a small temp file in /tmp, usually cleaned by OS.
             # Correct way: pass the temp path to a cleanup thread or list.
        except Exception as e:
             print(f"Failed to set viewer image: {e}")
             self._set_viewer_default(image_widget, "Error displaying image")
        return False

    def _set_viewer_default(self, image_widget, reason):
         """Set default icon and maybe tooltip."""
         # Gtk.Picture doesn't take icon names easily, need to check docs.
         # Actually it can take a paintable. or we can just replace the widget?
         # Changing widget is disruptive. 
         # Let's try to load the icon theme into a texture? Hard.
         # Simpler: Use a place holder file or just leave it empty?
         # Or maybe just use a separate Image widget if Picture fails?
         # Let's try to find a system icon path or just use no paintable.
         
         # Note: Gtk.Picture is for displaying content. 
         # If we want an icon, we might need a Gtk.Image inside or instead.
         # But we used Gtk.Picture above.
         
         # Fallback: Just don't show anything in Picture, and update label?
         pass

    def _toggle_playback(self):
        """Toggle play/pause from mini-player."""
        # pause() method toggles pause state
        self.engine.pause()
    
    def _update_mini_player_button(self, dialog):
        """Update mini-player button icon based on playback state."""
        if hasattr(dialog, 'play_pause_btn'):
            if self.engine.is_playing:
                dialog.play_pause_btn.set_icon_name("media-playback-pause-symbolic")
            else:
                dialog.play_pause_btn.set_icon_name("media-playback-start-symbolic")
        return False  # Don't repeat

    
    def _retry_cover_update(self, track, retry_count):
        """Retry cover art update after file is cached."""
        print(f"DEBUG: Retrying cover update... (attempt {retry_count + 1})")
        self.update_cover_art(track, retry_count)
        return False  # Don't repeat timeout

        
    def _update_ui_state(self, state):
        """Update UI elements based on playback state."""
        
        if state == 'playing':
            self.play_btn.set_icon_name("media-playback-pause-symbolic")
        else:
            self.play_btn.set_icon_name("media-playback-start-symbolic")
        return False  # Remove from idle queue if called via GLib.idle_add
    
    def _poll_engine_state(self):
        """Poll engine state and update button icon (runs every 250ms)."""
        if self.engine.is_playing:
            self.play_btn.set_icon_name("media-playback-pause-symbolic")
        else:
            self.play_btn.set_icon_name("media-playback-start-symbolic")
        return True  # Keep timer running
    
    def play_next(self, *args):
        """Play the next track in the library."""
        tracks = self.lib_manager.get_all_tracks()
        if not tracks: return
        
        current_id = self.engine.current_track.id if self.engine.current_track else None
        next_index = 0
        
        if current_id:
            for i, track in enumerate(tracks):
                if track.id == current_id:
                    next_index = (i + 1) % len(tracks)
                    break
        
        print(f"Playing next track: {tracks[next_index].title}")
        self.play_track(tracks[next_index])

    def play_previous(self, *args):
        """Play previous track or restart current if played long enough."""
        # Standard behavior: if > 3s played, restart song. Else go to prev.
        if self.engine.get_time() > 3:
            self.engine.seek(0)
            return

        tracks = self.lib_manager.get_all_tracks()
        if not tracks: return
        
        current_id = self.engine.current_track.id if self.engine.current_track else None
        prev_index = 0
        
        if current_id:
            for i, track in enumerate(tracks):
                if track.id == current_id:
                    prev_index = (i - 1) % len(tracks)
                    break
        
        print(f"Playing previous track: {tracks[prev_index].title}")
        self.play_track(tracks[prev_index])

    def play_first_track(self):
        """Play the first track in the library (used by MPRIS when no track is loaded)."""
        tracks = self.lib_manager.get_all_tracks()
        if tracks:
            print("MPRIS requested playback - starting first track.")
            self.play_track(tracks[0])
        else:
            print("Cannot play: library is empty.")
    

    def _init_player_ui(self, main_box, config):
        """Initialize the main player interface once config exists."""
        # Initialize Library Manager
        self.lib_manager = LibraryManager()
        
        # Create Tab View
        self.tab_view = TabView()
        
        # Create All Songs tab (main library view)
        self.library_ui = LibraryView(
            self.lib_manager,
            on_track_activated=self.play_track,
            queue_manager=self.queue_manager,
            favourites_manager=self.favourites_manager,
            show_favourites_only=False
        )
        
        # Click on library to unfocus search
        library_click = Gtk.GestureClick()
        library_click.connect("pressed", lambda g, n, x, y: self._unfocus_search())
        self.library_ui.add_controller(library_click)
        
        # Create Queue tab
        self.queue_view = QueueView(self.queue_manager)
        
        # Create Favourites tab (filtered library view)
        self.favourites_ui = LibraryView(
            self.lib_manager,
            on_track_activated=self.play_track,
            queue_manager=self.queue_manager,
            favourites_manager=self.favourites_manager,
            show_favourites_only=True
        )
        
        # Add pages to tab view
        self.tab_view.add_page(self.library_ui, "all_songs", "All Songs", visible=True)
        self.tab_view.add_page(self.queue_view, "queue", "Queue", visible=not self.queue_manager.is_empty())
        self.tab_view.add_page(self.favourites_ui, "favourites", "Favourites", visible=True)
        
        # Register queue change callback for tab visibility
        self.queue_manager.add_change_callback(self._update_queue_tab_visibility)
        
        main_box.append(self.tab_view)
        
        # Search Bar (at bottom)
        search_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        search_box.set_margin_start(12)
        search_box.set_margin_end(12)
        search_box.set_margin_top(4)
        search_box.set_margin_bottom(8)
        
        search_label = Gtk.Label(label="Search:")
        search_box.append(search_label)
        
        self.search_entry = Gtk.SearchEntry()
        self.search_entry.set_placeholder_text("Search by title or artist...")
        self.search_entry.set_hexpand(True)
        
        # ESC key to unfocus and clear
        search_key_controller = Gtk.EventControllerKey()
        search_key_controller.connect("key-pressed", self._on_search_key_pressed)
        self.search_entry.add_controller(search_key_controller)
        
        search_box.append(self.search_entry)
        
        main_box.append(search_box)
        
        # Connect search entry to active library view filter
        self.search_entry.connect("search-changed", self._on_search_changed)
    
    def _on_search_changed(self, entry):
        """Handle search changes - apply to current active tab."""
        current_tab = self.tab_view.get_visible_child_name()
        
        # Apply search to appropriate library view
        if current_tab == "all_songs":
            self.library_ui._on_search_changed(entry)
        elif current_tab == "favourites":
            self.favourites_ui._on_search_changed(entry)
    
    def _update_queue_tab_visibility(self):
        """Update queue tab visibility based on queue state."""
        GLib.idle_add(self._sync_queue_tab_visibility)
    
    def _sync_queue_tab_visibility(self):
        """Sync queue tab visibility (main thread)."""
        is_empty = self.queue_manager.is_empty()
        self.tab_view.set_tab_visible("queue", not is_empty)
        return False  # Remove from idle queue
    
    def _on_search_key_pressed(self, controller, keyval, keycode, state):
        """Handle ESC key in search entry."""
        if keyval == Gdk.KEY_Escape:
            self._unfocus_search()
            return True
        return False
    
    def _unfocus_search(self):
        """Remove focus from search entry."""
        # Set focus to main window (removes focus from search)
        self.set_focus(None)
    
    def _on_settings_clicked(self, action, param):
        """Open settings dialog."""
        app = self.get_application()
        print(f"DEBUG: MainWindow._on_settings_clicked - app = {app}")
        print(f"DEBUG: MainWindow._on_settings_clicked - app.set_theme = {app.set_theme}")
        print(f"DEBUG: MainWindow._on_settings_clicked - app.current_theme = {app.current_theme}")
        settings_dialog = SettingsDialog(
            parent=self,
            library_manager=self.lib_manager,
            on_theme_change=app.set_theme,
            current_theme=app.current_theme
        )
        print(f"DEBUG: Created SettingsDialog, on_theme_change = {settings_dialog.on_theme_change}")
        settings_dialog.present()


    
    def _show_first_run_wizard(self):
        """Show setup wizard for first-run configuration."""
        from player.ui.setup_wizard import SetupWizard
        
        wizard = SetupWizard(transient_for=self)
        wizard.connect('close-request', self._on_wizard_closed)
        wizard.present()
    
    def _on_wizard_closed(self, wizard):
        """Handle wizard completion or cancellation."""
        # Check if config now exists
        config = self._load_config()
        if config:
            # Config was created - reload the window
            print("✓ Setup complete! Reloading player...")
            # TODO: Reload the main UI without restarting
            # For now, just show a message
            self.set_title("Music Hub - Please restart the app")
        else:
            # Wizard was cancelled - close app
            print("Setup cancelled. Exiting...")
            self.close()
    
    def show_wizard(self):
        """Show setup wizard (can be called from menu)."""
        from player.ui.setup_wizard import SetupWizard
        
        wizard = SetupWizard(transient_for=self)
        wizard.present()

    def refresh_library(self):
        """Reload the library from the provider (called by other dialogs)."""
        print("External request to refresh library...")
        if hasattr(self, 'library_ui'):
            self.library_ui.refresh()

    def _load_config(self):
        """Load player configuration from file."""
        config_file = Path(DEFAULT_CONFIG_DIR).expanduser() / "config.json"
        try:
            if config_file.exists():
                with open(config_file, 'r') as f:
                    return PlayerConfig.from_json(f.read())
        except Exception as e:
            print(f"Error loading config: {e}")
        return None

if __name__ == "__main__":
    app = MusicApp(application_id="com.shmusichub.player")
    app.run(None)


