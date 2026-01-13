import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')
from gi.repository import Gtk, Adw, Gio, GObject, GLib, Gdk
from shared.constants import DEFAULT_CONFIG_DIR, DEFAULT_LIBRARY_PATH
from shared.models import PlayerConfig
from player.library import LibraryManager
from player.engine import PlaybackEngine
from .library import LibraryView
from pathlib import Path
import os
import json

class MusicApp(Adw.Application):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.connect('activate', self.on_activate)
        
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
                print("⚠ Please run setup wizard first")
                return
            
            dialog = UploadDialog(config=config, transient_for=self.win)
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
        
        # Force Dark Mode
        style_manager = Adw.StyleManager.get_default()
        style_manager.set_color_scheme(Adw.ColorScheme.FORCE_DARK)

        self.win = MainWindow(application=app)
        self.win.present()

class MainWindow(Adw.ApplicationWindow):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        
        print("DEBUG: MainWindow initializing...")
        self.set_title("Music Hub")
        self.set_default_size(1000, 700)
        
        # Audio Engine
        print("DEBUG: Initializing PlaybackEngine...")
        self.engine = PlaybackEngine()
        print("DEBUG: PlaybackEngine initialized.")
        self.engine.set_state_change_callback(self.on_player_state_change)
        
        
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
        main_box.append(header)
        
        # Title
        self.title_widget = Adw.WindowTitle(title="Music Hub", subtitle="Local Library")
        header.set_title_widget(self.title_widget)
        
        # Settings menu button (right side)
        menu_button = Gtk.MenuButton()
        menu_button.set_icon_name("open-menu-symbolic")
        menu = Gio.Menu()
        
        # Setup section
        setup_section = Gio.Menu()
        setup_section.append("Setup Wizard", "app.setup-wizard")
        setup_section.append("Upload Music", "app.upload-music")
        menu.append_section(None, setup_section)
        
        # About section
        about_section = Gio.Menu()
        about_section.append("About", "app.about")
        menu.append_section(None, about_section)
        
        menu_button.set_menu_model(menu)
        header.pack_end(menu_button)

        # Player Control Bar (Top)
        player_container = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        player_container.add_css_class("toolbar")
        player_container.set_spacing(8)
        # Add some padding to the container itself if needed, usually css handles it via toolbar class
        
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
        
        # 1. Cover Art
        self.cover_art = Gtk.Image()
        self.cover_art.set_pixel_size(48)
        self.cover_art.set_size_request(48, 48)
        self.cover_art.add_css_class("card")
        self.cover_art.set_from_icon_name("emblem-music-symbolic")
        self.cover_art.set_margin_end(12)
        player_container.append(self.cover_art)
        
        # 2. Track Info
        info_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        info_box.set_valign(Gtk.Align.CENTER)
        info_box.set_margin_end(12)
        
        self.title_label = Gtk.Label(label="Not Playing")
        self.title_label.add_css_class("title-4")
        self.title_label.set_halign(Gtk.Align.START)
        self.title_label.set_ellipsize(3) # END
        self.title_label.set_max_width_chars(25)
        
        self.artist_label = Gtk.Label(label="--")
        self.artist_label.add_css_class("caption")
        self.artist_label.set_halign(Gtk.Align.START)
        self.artist_label.set_ellipsize(3)
        self.artist_label.set_max_width_chars(25)
        
        info_box.append(self.title_label)
        info_box.append(self.artist_label)
        player_container.append(info_box)

        # 3. Play/Pause Button
        self.play_btn = Gtk.Button(icon_name="media-playback-start-symbolic")
        self.play_btn.add_css_class("circular")
        self.play_btn.add_css_class("play-button")
        self.play_btn.set_valign(Gtk.Align.CENTER)
        self.play_btn.connect('clicked', self.on_play_toggle)
        player_container.append(self.play_btn)
        
        # 4. Progress Bar (Scale)
        self.progress_scale = Gtk.Scale(orientation=Gtk.Orientation.HORIZONTAL)
        self.progress_scale.set_draw_value(False)
        self.progress_scale.set_range(0, 100) # Default, updated on play
        self.progress_scale.set_hexpand(True) # Fill remaining space
        self.progress_scale.set_valign(Gtk.Align.CENTER)
        self.progress_scale.set_margin_start(12)
        self.progress_scale.set_margin_end(5)
        self.progress_scale.connect('value-changed', self.on_seek)
        player_container.append(self.progress_scale)
        
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

    def on_player_state_change(self, state):
        """Callback from engine (thread safe wrapper)."""
        GLib.idle_add(self._update_ui_state, state)

    def on_play_toggle(self, button):
        if self.engine.is_playing:
            self.engine.pause()
        else:
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

    def on_time_update(self, time):
        """Callback from engine when playback time updates."""
        # Schedule UI update on main thread
        GLib.idle_add(self._update_scale_safe, time)

    def _update_scale_safe(self, time):
        """Update progress scale on main thread (thread-safe)."""
        self._seeking = True
        self.progress_scale.set_value(time)
        self._seeking = False
        return False  # Remove callback from idle queue to prevent memory leak

    def play_track(self, track):
        """Called when a track is double-clicked in the library."""
        print(f"Requesting play for: {track.title}")
        url = self.lib_manager.get_track_url(track)
        if url:
             self.engine.play(url, track)
             self.title_widget.set_subtitle(f"Playing: {track.title}")
             # Wait for MPV to load and get actual duration
             GLib.timeout_add(100, self._update_duration_range, track)
        else:
             print("Error: Could not resolve URL for track.")
    
    def _update_duration_range(self, track):
        """Update progress bar range after track loads in MPV."""
        duration = self.engine.get_duration()
        if duration and duration > 0:
            self.progress_scale.set_range(0, duration)
        elif track.duration:
            self.progress_scale.set_range(0, track.duration)
        else:
            self.progress_scale.set_range(0, 300)  # Fallback
        return False  # Remove from timeout queue

        
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
        
        # Library View
        self.library_view = LibraryView(self.lib_manager, on_track_activated=self.play_track)
        main_box.append(self.library_view)
        
        # Need to set expand so it fills space
        self.library_view.set_vexpand(True)
    
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
