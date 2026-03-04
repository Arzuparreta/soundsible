import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')
from gi.repository import Gtk, Adw, Gio, GObject, GLib, Gdk
from shared.constants import DEFAULT_CONFIG_DIR, DEFAULT_LIBRARY_PATH, DEFAULT_CACHE_DIR, LIBRARY_METADATA_FILENAME
from shared.models import PlayerConfig, LibraryMetadata
from player.cover_manager import CoverFetchManager
from player.library import LibraryManager
from player.ui.library import LibraryView
from player.ui.settings import SettingsDialog
from player.engine import PlaybackEngine
from player.queue_manager import QueueManager
from player.ui.queue_view import QueueView
from player.favourites_manager import FavouritesManager
from player.ui.tab_view import TabView
from player.ui.album_grid import AlbumGridView
from .volume_knob import VolumeKnob
from pathlib import Path
import json
import os


class UIConstants:
    """UI dimension constants for consistent sizing."""
    COVER_ART_SIZE = 48
    SIDEBAR_WIDTH = 300
    PROGRESS_BAR_MIN_WIDTH = 200  # Increased from 150 for better usability
    TITLE_MIN_WIDTH = 50
    TITLE_MAX_WIDTH = 250  # Increased for better readability


class MusicApp(Adw.Application):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        import sys
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
        
        # Sync QR action (App level)
        sync_qr_action = Gio.SimpleAction.new("show-sync-qr", None)
        sync_qr_action.connect("activate", self.on_show_sync_qr)
        self.add_action(sync_qr_action)
        
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
    
    def on_show_sync_qr(self, action, param):
        """Show sync QR code."""
        if hasattr(self, 'win'):
            self.win.show_sync_qr()
    
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

            dialog = DownloadDialog(library_manager=getattr(self.win, 'lib_manager', None), transient_for=self.win)
            dialog.present()
    
    def on_about(self, action, param):
        """Show about dialog."""
        if hasattr(self, 'win'):
            about = Adw.AboutWindow(
                transient_for=self.win,
                application_name="Soundsible",
                application_icon="folder-music-symbolic",
                developer_name="Soundsible Team",
                version="1.0.0",
                website="https://github.com/Arzuparreta/soundsible",
                issue_url="https://github.com/Arzuparreta/soundsible/issues",
                license_type=Gtk.License.MIT_X11
            )
            _icon_path = Path(__file__).resolve().parent.parent / "ui_web" / "assets" / "icons" / "icon-512.png"
            if _icon_path.exists():
                try:
                    about.set_icon(Gdk.Texture.new_from_filename(str(_icon_path)))
                except Exception:
                    pass
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
        try:
            if prefs_file.exists():
                with open(prefs_file, 'r') as f:
                    prefs = json.load(f)
                    theme = prefs.get('theme', 'default')
                    return theme
        except Exception as e:
            print(f"ERROR loading theme preference: {e}")
            import traceback
            traceback.print_exc()
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
            
        except Exception as e:
            print(f"Error saving theme preference: {e}")
    
    def set_theme(self, theme_name):
        """Set application theme."""
        
        self.current_theme = theme_name  # Track current theme
        style_manager = Adw.StyleManager.get_default()
        display = Gdk.Display.get_default()
        
        # Defensive check: ensure display is valid
        if display is None:
            print(f"ERROR: Display is None! Cannot set theme. This shouldn't happen.")
            return
        

        # Remove existing theme provider if any
        if self.theme_provider:
            try:
                Gtk.StyleContext.remove_provider_for_display(display, self.theme_provider)
            except Exception as e:
                print(f"WARNING: Failed to remove previous theme provider: {e}")
            self.theme_provider = None

        # Apply theme based on selection
        try:
            if theme_name == "light":
                style_manager.set_color_scheme(Adw.ColorScheme.FORCE_LIGHT)
                # Load light theme CSS
                self.theme_provider = Gtk.CssProvider()
                css_path = os.path.join(os.path.dirname(__file__), 'theme_light.css')
                self.theme_provider.load_from_path(css_path)
                Gtk.StyleContext.add_provider_for_display(
                    display, 
                    self.theme_provider, 
                    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1
                )
                
            elif theme_name == "dark":
                style_manager.set_color_scheme(Adw.ColorScheme.FORCE_DARK)
                # Load dark theme CSS
                self.theme_provider = Gtk.CssProvider()
                css_path = os.path.join(os.path.dirname(__file__), 'theme_dark.css')
                self.theme_provider.load_from_path(css_path)
                Gtk.StyleContext.add_provider_for_display(
                    display, 
                    self.theme_provider, 
                    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1
                )
                
            elif theme_name == "odst":
                style_manager.set_color_scheme(Adw.ColorScheme.FORCE_DARK)
                # Load ODST theme CSS
                self.theme_provider = Gtk.CssProvider()
                css_path = os.path.join(os.path.dirname(__file__), 'theme_odst.css')
                self.theme_provider.load_from_path(css_path)
                Gtk.StyleContext.add_provider_for_display(
                    display, 
                    self.theme_provider, 
                    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1
                )
                
            else:  # "default" or any other value
                style_manager.set_color_scheme(Adw.ColorScheme.DEFAULT)
                
        except Exception as e:
            print(f"ERROR: Failed to apply theme '{theme_name}': {e}")
            import traceback
            traceback.print_exc()
            return
        
        # Save theme preference
        self._save_theme_preference(theme_name)



class MainWindow(Adw.ApplicationWindow):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        
        self.set_title("Soundsible")
        self.set_default_size(1000, 700)

        # Application icon from repo branding (ui_web/assets/icons generated from branding/)
        _repo_root = Path(__file__).resolve().parent.parent
        _icon_path = _repo_root / "ui_web" / "assets" / "icons" / "icon-512.png"
        if _icon_path.exists():
            try:
                self.set_icon(Gdk.Texture.new_from_filename(str(_icon_path)))
            except Exception:
                pass

        # Queue Manager
        self.queue_manager = QueueManager()
        
        # Favourites Manager
        self.favourites_manager = FavouritesManager()
        
        # Audio Engine
        self.engine = PlaybackEngine(queue_manager=self.queue_manager)
        self.engine.set_state_change_callback(self.on_player_state_change)
        self.engine.add_track_end_callback(self.on_track_ended)
        self.engine.set_track_load_callback(self.play_track)  # For auto-play from queue
        
        
        # MPRIS Integration (optional - requires mpris_server package)
        try:
            from player.mpris import SoundsibleMpris
            from mpris_server import Server
            
            self.mpris = SoundsibleMpris(self.engine, self)
            self.mpris_server = Server('Soundsible', adapter=self.mpris)
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
        main_box.add_css_class("main-window-content")
        self.set_content(main_box)
        
        # Header Bar
        header = Adw.HeaderBar()
        self.title_widget = Adw.WindowTitle(title="Soundsible", subtitle="Local Library")
        header.set_title_widget(self.title_widget)
        main_box.append(header)

        # View Stack for switching between Main and Mini modes
        self.view_stack = Gtk.Stack()
        self.view_stack.add_css_class("view-stack")
        self.view_stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
        self.view_stack.set_transition_duration(300)
        main_box.append(self.view_stack)

        # Main View Container
        self.main_view = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.main_view.add_css_class("main-view")
        self.view_stack.add_named(self.main_view, "main")
        
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
        setup_section.append("Sync to Mobile (QR)", "app.show-sync-qr")
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

        # Mini Mode Toggle Button
        self.mini_mode_btn = Gtk.ToggleButton()
        self.mini_mode_btn.set_icon_name("view-restore-symbolic")
        self.mini_mode_btn.set_tooltip_text("Toggle Mini Player (F12)")
        self.mini_mode_btn.connect("toggled", self.on_mini_mode_toggled)
        header.pack_end(self.mini_mode_btn)


        
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
        self.cover_art.set_pixel_size(UIConstants.COVER_ART_SIZE)
        self.cover_art.set_size_request(UIConstants.COVER_ART_SIZE, UIConstants.COVER_ART_SIZE)
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
        self.title_scroll.set_min_content_width(UIConstants.TITLE_MIN_WIDTH)
        self.title_scroll.set_max_content_width(UIConstants.TITLE_MAX_WIDTH)
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
        self.progress_scale.set_size_request(UIConstants.PROGRESS_BAR_MIN_WIDTH, -1)
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
        
        self.main_view.append(player_container)

        # Content Area (Split View)
        # Check for config and show wizard if needed
        config = self._load_config()
        if config:
            self._init_player_ui(self.main_view, config)
        else:
            # No config - show setup wizard
            self._show_first_run_wizard()
        
        # Initialize Mini Player View
        self._init_mini_player_ui()
        
        # Connect Time Update
        self.engine.set_time_update_callback(self.on_time_update)
        self._seeking = False
        
        # Poll engine state to update button icon (simple fix)
        GLib.timeout_add(250, self._poll_engine_state)
        
        
        # Keyboard shortcuts for playback control
        # Use CAPTURE phase to intercept keys before child widgets
        key_controller = Gtk.EventControllerKey()
        key_controller.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        key_controller.connect("key-pressed", self._on_key_pressed)
        self.add_controller(key_controller)

    def _on_settings_clicked(self, action, param):
        """Show settings dialog."""
        app = self.get_application()
        dialog = SettingsDialog(
            parent=self, 
            library_manager=self.lib_manager, 
            on_theme_change=app.set_theme,
            current_theme=app.current_theme
        )
        dialog.present()

    def _on_key_pressed(self, controller, keyval, keycode, state):
        """Handle keyboard shortcuts for playback control."""
        # Don't intercept keys when typing in text entry widgets
        focus_widget = self.get_focus()
        if isinstance(focus_widget, (Gtk.Entry, Gtk.SearchEntry, Gtk.Text, Gtk.TextView)):
            return False  # Let text input work normally
        
        # Space: Play/Pause toggle
        if keyval == Gdk.KEY_space:
            self.on_play_toggle(None)
            return True
        
        # Left arrow: Seek backward 10 seconds
        elif keyval == Gdk.KEY_Left:
            if self.engine.current_track:
                current = self.engine.get_time() or 0
                self.engine.seek(max(0, current - 10))
            return True
        
        # Right arrow: Seek forward 10 seconds
        elif keyval == Gdk.KEY_Right:
            if self.engine.current_track:
                current = self.engine.get_time() or 0
                duration = self.engine.get_duration() or 300
                self.engine.seek(min(duration, current + 10))
            return True
        
        # N: Next track
        elif keyval == Gdk.KEY_n or keyval == Gdk.KEY_N:
            self.play_next(None)
            return True
        
        # P: Previous track 
        elif keyval == Gdk.KEY_p or keyval == Gdk.KEY_P:
            self.play_previous(None)
            return True
        
        # M: Mute toggle
        elif keyval == Gdk.KEY_m or keyval == Gdk.KEY_M:
            current_vol = self.volume_knob.get_value()
            if current_vol > 0:
                self._saved_volume = current_vol
                self.volume_knob.set_value(0)
            else:
                self.volume_knob.set_value(getattr(self, '_saved_volume', 100))
            return True
        
        # Up arrow: Volume up 5%
        elif keyval == Gdk.KEY_Up:
            current_vol = self.volume_knob.get_value()
            self.volume_knob.set_value(min(100, current_vol + 5))
            return True
        
        # Down arrow: Volume down 5%
        elif keyval == Gdk.KEY_Down:
            current_vol = self.volume_knob.get_value()
            self.volume_knob.set_value(max(0, current_vol - 5))
            return True

        # F12: Toggle Mini Mode
        elif keyval == Gdk.KEY_F12:
            self.mini_mode_btn.set_active(not self.mini_mode_btn.get_active())
            return True
        
        return False  # Let other handlers process the key

    def on_mini_mode_toggled(self, btn):
        """Switch between main and mini player views."""
        is_mini = btn.get_active()
        if is_mini:
            self.view_stack.set_visible_child_name("mini")
            self.set_default_size(300, 450)
            self.set_resizable(False)
        else:
            self.view_stack.set_visible_child_name("main")
            self.set_default_size(1000, 700)
            self.set_resizable(True)

    def _init_mini_player_ui(self):
        """Initialize the Mini Player view for small windows."""
        mini_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        mini_box.add_css_class("mini-player-view")
        mini_box.set_valign(Gtk.Align.CENTER)
        mini_box.set_halign(Gtk.Align.CENTER)
        mini_box.set_spacing(16)
        mini_box.set_margin_top(24)
        mini_box.set_margin_bottom(24)
        
        # 1. Large Cover Art
        self.mini_cover = Gtk.Image()
        self.mini_cover.set_pixel_size(240)
        self.mini_cover.set_size_request(240, 240)
        self.mini_cover.add_css_class("card")
        self.mini_cover.set_from_icon_name("emblem-music-symbolic")
        self.mini_cover.set_halign(Gtk.Align.CENTER)
        mini_box.append(self.mini_cover)
        
        # 2. Title & Artist
        info_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        info_box.set_halign(Gtk.Align.CENTER)
        
        self.mini_title = Gtk.Label(label="Soundsible")
        self.mini_title.add_css_class("title-2") # Large title
        self.mini_title.set_ellipsize(3)
        self.mini_title.set_max_width_chars(20)
        
        self.mini_artist = Gtk.Label(label="Not Playing")
        self.mini_artist.add_css_class("title-4")
        self.mini_artist.add_css_class("dim-label")
        self.mini_artist.set_ellipsize(3)
        self.mini_artist.set_max_width_chars(20)
        
        info_box.append(self.mini_title)
        info_box.append(self.mini_artist)
        mini_box.append(info_box)
        
        # 3. Progress Bar
        self.mini_scale = Gtk.Scale(orientation=Gtk.Orientation.HORIZONTAL)
        self.mini_scale.set_size_request(200, -1)
        self.mini_scale.set_draw_value(False)
        self.mini_scale.add_css_class("seek-bar")
        self.mini_scale.connect('value-changed', self.on_seek)
        mini_box.append(self.mini_scale)
        
        # Time Label
        self.mini_time_label = Gtk.Label(label="0:00 / 0:00")
        self.mini_time_label.add_css_class("numeric")
        mini_box.append(self.mini_time_label)

        # 4. Controls
        controls = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=24)
        controls.set_halign(Gtk.Align.CENTER)
        
        # Prev
        prev = Gtk.Button(icon_name="media-skip-backward-symbolic")
        prev.add_css_class("circular")
        prev.connect('clicked', self.play_previous)
        controls.append(prev)
        
        # Play/Pause
        self.mini_play_btn = Gtk.Button(icon_name="media-playback-start-symbolic")
        self.mini_play_btn.add_css_class("circular")
        self.mini_play_btn.add_css_class("play-button") 
        self.mini_play_btn.set_size_request(64, 64)
        self.mini_play_btn.connect('clicked', self.on_play_toggle)
        controls.append(self.mini_play_btn)
        
        # Next
        next_btn = Gtk.Button(icon_name="media-skip-forward-symbolic")
        next_btn.add_css_class("circular")
        next_btn.connect('clicked', self.play_next)
        controls.append(next_btn)
        
        mini_box.append(controls)
        
        # Add to stack
        self.view_stack.add_named(mini_box, "mini")


    def on_player_state_change(self, state):
        """Callback from engine (thread safe wrapper)."""
        GLib.idle_add(self._update_ui_state, state)

    def on_track_ended(self):
        """Callback from engine when track finishes."""
        # Stop engine to reset state and update UI (run on main thread)
        def _stop_safe():
            self.engine.stop()
            return False
            
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
        self.mini_scale.set_value(time)
        
        # Update time label
        total = self.progress_scale.get_adjustment().get_upper()
        
        t_str = f"{self._format_time(time)} / {self._format_time(total)}"
        self.time_label.set_text(t_str)
        self.mini_time_label.set_text(t_str)
        
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
             
             # Mini View Sync
             self.mini_title.set_text(track.title)
             self.mini_artist.set_text(track.artist)
             
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
                        return
                    
                    # Download to cache
                    remote_key = f"tracks/{track.id}.{track.format}"
                    
                    import tempfile
                    import os
                    # Download to temp first
                    fd, temp_path = tempfile.mkstemp(suffix=f".{track.format}")
                    os.close(fd)
                    
                    if self.lib_manager.provider.download_file(remote_key, temp_path):
                        # Add to cache
                        cached_path = self.lib_manager.cache.add_to_cache(track.id, temp_path, move=True)
                        # Trigger cover update now that file is cached
                        GLib.idle_add(self.update_cover_art, track, 0)
                    else:
                        os.remove(temp_path)
            except Exception as e:
                import traceback
                traceback.print_exc()
        
        threading.Thread(target=download_to_cache, daemon=True).start()
    
    def _update_duration_range(self, track):
        """Update progress bar range after track loads in MPV."""
        duration = self.engine.get_duration()
        if duration and duration > 0:
            rng = (0, duration)
        elif track.duration:
            rng = (0, track.duration)
        else:
            rng = (0, 300)  # Fallback
            
        self.progress_scale.set_range(*rng)
        self.mini_scale.set_range(*rng)

        # Update time label with new duration
        total = self.progress_scale.get_adjustment().get_upper()
        current = self.progress_scale.get_value()
        t_str = f"{self._format_time(current)} / {self._format_time(total)}"
        self.time_label.set_text(t_str)
        self.mini_time_label.set_text(t_str)
        
        return False  # Remove from timeout queue
    
    def update_cover_art(self, track, retry_count=0):
        """Extract and display cover art for the given track."""
        try:
            from setup_tool.audio import AudioProcessor
            from gi.repository import GdkPixbuf
            import tempfile
            import os
            
            
            # Get local file path (from cache or download)
            local_path = None
            
            # Try cache first
            if self.lib_manager.cache:
                cached = self.lib_manager.cache.get_cached_path(track.id)
                if cached and os.path.exists(cached):
                    local_path = cached
            
            if not local_path:
                # File not cached yet, retry after a delay (max 3 attempts)
                if retry_count < 3:
                    GLib.timeout_add(2000, self._retry_cover_update, track, retry_count + 1)
                else:
                    # Fallback: Trigger online fetch
                    self._fetch_online_cover(track)
                    
                self.cover_art.set_from_icon_name("emblem-music-symbolic")
                return
            
            # Check Local Cover Cache FIRST (Smart Fetch Result)
            covers_dir = os.path.join(os.path.expanduser(DEFAULT_CACHE_DIR), "covers")
            local_cover_path = os.path.join(covers_dir, f"{track.id}.jpg")
            
            if os.path.exists(local_cover_path):
                try:
                    pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
                        local_cover_path, 48, 48, True
                    )
                    self.cover_art.set_from_pixbuf(pixbuf)
                    
                    mini_pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
                        local_cover_path, 240, 240, True
                    )
                    self.mini_cover.set_from_pixbuf(mini_pixbuf)
                    return # Done!
                except Exception as e:
                    pass

            # Extract cover art from file
            cover_data = AudioProcessor.extract_cover_art(local_path)
            
            if cover_data:
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
                    
                    mini_pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
                        tmp_path, 240, 240, True
                    )
                    self.mini_cover.set_from_pixbuf(mini_pixbuf)

                finally:
                    os.remove(tmp_path)
            else:
                # No cover found, use default
                self.cover_art.set_from_icon_name("emblem-music-symbolic")
                self.mini_cover.set_from_icon_name("emblem-music-symbolic")
                
                # Fallback: Trigger online fetch
                self._fetch_online_cover(track)
                
                
        except Exception as e:
            if "No cover data" not in str(e):
                import traceback
                traceback.print_exc()
            self.cover_art.set_from_icon_name("emblem-music-symbolic")
            self.mini_cover.set_from_icon_name("emblem-music-symbolic")

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
        icon = "media-playback-pause-symbolic" if self.engine.is_playing else "media-playback-start-symbolic"
        self.play_btn.set_icon_name(icon)
        self.mini_play_btn.set_icon_name(icon)
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
    

    def _init_player_ui(self, container, config):
        """Initialize the main player interface once config exists."""
        # Initialize Library Manager
        self.lib_manager = LibraryManager()
        
        # Create Main Content Box (Horizontal split)
        content_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        content_box.add_css_class("content-split")
        content_box.set_vexpand(True)
        container.append(content_box)

        # Create Tab View (Left side, expansive via hexpand)
        self.tab_view = TabView()
        self.tab_view.set_hexpand(True)
        content_box.append(self.tab_view)
        
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
        
        self.album_grid = AlbumGridView(
            self.lib_manager,
            on_album_activated=self._on_album_activated
        )
        self.tab_view.add_page(self.album_grid, "albums", "Albums", visible=True)
        
        self.tab_view.add_page(self.favourites_ui, "favourites", "Favourites", visible=True)

        # Create Queue Sidebar (Right side)
        # We wrap it in a box to include a separator
        self.sidebar_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        self.sidebar_box.add_css_class("sidebar-panel")
        self.sidebar_box.set_vexpand(True) # Ensure it fills height
        self.sidebar_box.set_visible(False) # Hidden by default
        content_box.append(self.sidebar_box)

        # Separator
        separator = Gtk.Separator(orientation=Gtk.Orientation.VERTICAL)
        self.sidebar_box.append(separator)

        # Sidebar content
        self.queue_view = QueueView(self.queue_manager)
        self.queue_view.set_size_request(UIConstants.SIDEBAR_WIDTH, -1)
        self.queue_view.set_hexpand(False)
        self.sidebar_box.append(self.queue_view)
        
        # Register queue change callback for sidebar visibility
        self.queue_manager.add_change_callback(self._update_queue_sidebar_visibility)
        
        # Search Bar (at bottom)
        search_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        search_box.add_css_class("search-bar")
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
        
        container.append(search_box)
        
        # Connect search entry to active library view filter
        self.search_entry.connect("search-changed", self._on_search_changed)
    
    def _on_search_changed(self, entry):
        """Handle search changes - apply to current active tab."""
        current_tab_name = self.tab_view.get_visible_child_name()
        
        # Apply search to appropriate library view
        if current_tab_name == "all_songs":
            self.library_ui._on_search_changed(entry)
        elif current_tab_name == "favourites":
            self.favourites_ui._on_search_changed(entry)
        elif current_tab_name.startswith("album_"):
            # Dynamic album tab
            page = self.tab_view.get_page(current_tab_name)
            if page and hasattr(page, '_on_search_changed'):
                page._on_search_changed(entry)
    
    def _update_queue_sidebar_visibility(self):
        """Update queue sidebar visibility based on queue state."""
        GLib.idle_add(self._sync_queue_sidebar_visibility)
    
    def _sync_queue_sidebar_visibility(self):
        """Sync queue sidebar visibility (main thread)."""
        is_empty = self.queue_manager.is_empty()
        if hasattr(self, 'sidebar_box'):
            self.sidebar_box.set_visible(not is_empty)
        return False  # Remove from idle queue
    
    def _on_search_key_pressed(self, controller, keyval, keycode, state):
        """Handle ESC key in search entry."""
        if keyval == Gdk.KEY_Escape:
            self._unfocus_search()
            return True
        return False
    
    def _on_album_activated(self, album_obj, tracks):
        """When an album is clicked in grid, open a dedicated tab."""
        album_name = album_obj.album
        tab_id = f"album_{album_name}"
        
        # Check if tab already exists
        existing_page = self.tab_view.get_page(tab_id)
        if existing_page:
            self.tab_view.set_visible_child_name(tab_id)
            return

        # Create new album-specific view
        album_view = LibraryView(
            self.lib_manager,
            on_track_activated=self.play_track,
            queue_manager=self.queue_manager,
            favourites_manager=self.favourites_manager,
            show_favourites_only=False,
            album_filter=album_name,
            album_artist_filter=album_obj.artist
        )
        
        # Add as a closable page
        # Position it next to Favorites
        self.tab_view.add_page(album_view, tab_id, album_name, visible=True, closable=True, insert_before="favourites")
        self.tab_view.set_visible_child_name(tab_id)

    def _unfocus_search(self):
        """Remove focus from search entry."""
        # Set focus to main window (removes focus from search)
        self.set_focus(None)
    


    
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
            self.set_title("Soundsible - Please restart the app")
        else:
            # Wizard was cancelled - close app
            print("Setup cancelled. Exiting...")
            self.close()
    
    def show_wizard(self):
        """Show setup wizard (can be called from menu)."""
        from player.ui.setup_wizard import SetupWizard
        
        wizard = SetupWizard(transient_for=self)
        wizard.present()

    def show_sync_qr(self):
        """Generate and show sync QR code with dual URLs for LAN and Tailscale."""
        print("DEBUG: [QR] Method triggered")
        import json
        import zlib
        import base64
        import segno
        import io
        import socket
        from gi.repository import GdkPixbuf
        
        # Detect IPs
        tailscale_ip = None
        local_ip = "localhost"
        try:
            # 1. Try to find Tailscale IP
            import subprocess
            ts_out = subprocess.check_output(["tailscale", "ip", "-4"]).decode().strip()
            if ts_out: tailscale_ip = ts_out
        except: pass

        try:
            # 2. Find local Wi-Fi IP
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            local_ip = s.getsockname()[0]
            s.close()
        except: pass
            
        lan_url = f"http://{local_ip}:5005/player/"
        ts_url = f"http://{tailscale_ip}:5005/player/" if tailscale_ip else None
        
        config = self._load_config()
        if not config:
            print("DEBUG: [QR] ❌ No config found")
            return

        try:
            print("DEBUG: [QR] Generating token...")
            config_data = config.to_dict()
            
            # Smart Resolver: Pack all available network endpoints
            from shared.api import get_active_endpoints
            config_data['endpoints'] = get_active_endpoints()
            config_data['port'] = 5005
            
            json_bytes = json.dumps(config_data).encode('utf-8')
            compressed = zlib.compress(json_bytes)
            token = base64.urlsafe_b64encode(compressed).decode('utf-8')
            
            # Create MessageDialog
            dialog = Adw.MessageDialog(
                transient_for=self,
                heading="Sync to Mobile",
            )
            dialog.add_response("close", "Close")
            dialog.set_default_response("close")
            dialog.set_close_response("close")
            
            # Add content
            content_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
            
            # URL Display
            url_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
            
            if ts_url:
                ts_label = Gtk.Label()
                ts_label.set_markup(f"<b>Universal (Tailscale - Recommended):</b>\n<span color='#10b981' weight='bold' size='large'>{ts_url}</span>")
                ts_label.set_selectable(True)
                url_box.append(ts_label)
                
                desc_ts = Gtk.Label()
                desc_ts.set_markup("<span size='small' weight='bold'>Use this link ALWAYS if you have Tailscale.</span>\n<span size='x-small' alpha='70%'>It works both at home and away seamlessly.</span>")
                url_box.append(desc_ts)
                
                # Add a separator or extra spacing
                spacer = Gtk.Box(margin_top=5, margin_bottom=5)
                url_box.append(spacer)

            lan_label = Gtk.Label()
            label_prefix = "<b>Local (Wi-Fi Only - Legacy):</b>" if ts_url else "<b>At Home (Wi-Fi):</b>"
            lan_label.set_markup(f"{label_prefix}\n<span color='#3b82f6' weight='bold'>{lan_url}</span>")
            lan_label.set_selectable(True)
            url_box.append(lan_label)
            
            if ts_url:
                desc_lan = Gtk.Label()
                desc_lan.set_markup("<span size='x-small' alpha='70%'>Only use this if you don't have Tailscale.</span>")
                url_box.append(desc_lan)
                
            content_box.append(url_box)

            # QR Image
            loader = GdkPixbuf.PixbufLoader.new_with_type("png")
            qr = segno.make(token)
            out = io.BytesIO()
            qr.save(out, kind='png', scale=5)
            loader.write(out.getvalue())
            loader.close()
            
            qr_image = Gtk.Image.new_from_pixbuf(loader.get_pixbuf())
            qr_image.set_pixel_size(250)
            qr_image.set_margin_top(10)
            qr_image.set_margin_bottom(10)
            content_box.append(qr_image)
            
            # Manual token
            expander = Gtk.Expander(label="Show manual token")
            token_entry = Gtk.Entry(text=token)
            token_entry.set_editable(False)
            token_entry.add_css_class("flat")
            expander.set_child(token_entry)
            content_box.append(expander)
            
            dialog.set_extra_child(content_box)
            dialog.present()
            
        except Exception as e:
            print(f"DEBUG: [QR] ❌ ERROR: {e}")
            import traceback
            traceback.print_exc()

    def refresh_library(self, new_metadata=None):
        """Reload the library and update UI instantly."""
        print("External request to refresh library...")
        
        if new_metadata:
            # 1. Update Managers Synchronously
            self.lib_manager.metadata = new_metadata
            self.lib_manager.db.sync_from_metadata(new_metadata)
            
            # Save to local library.json only (bypass cloud sync since uploader already did it)
            cache_path = Path(DEFAULT_CONFIG_DIR).expanduser() / LIBRARY_METADATA_FILENAME
            cache_path.write_text(new_metadata.to_json())
            
            # 2. Force Synchronous UI Update on Main Thread
            def _do_instant_refresh():
                # Update Song List
                if hasattr(self, 'library_ui'):
                    self.library_ui.set_tracks(new_metadata.tracks)
                
                # Update Favourites List
                if hasattr(self, 'favourites_ui'):
                    fav_ids = set(self.favourites_manager.get_all())
                    fav_tracks = [t for t in new_metadata.tracks if t.id in fav_ids]
                    self.favourites_ui.set_tracks(fav_tracks)
                
                # Update Album Grid
                if hasattr(self, 'album_grid'):
                    albums = self.lib_manager.db.get_albums()
                    self.album_grid.set_albums(albums)
                
                # Update any open album tabs
                if hasattr(self, 'tab_view'):
                    # TabView might have dynamic album pages
                    # We iterate through all pages and refresh if they are LibraryViews
                    # This is cleaner than hardcoding tab names
                    for page_name in self.tab_view.get_page_names():
                        page = self.tab_view.get_page(page_name)
                        if isinstance(page, LibraryView):
                            # Filter tracks if the view has an album filter
                            if page.album_filter:
                                album_tracks = [t for t in new_metadata.tracks if t.album == page.album_filter]
                                page.set_tracks(album_tracks)
                            elif page == self.library_ui:
                                # Already handled above, but for consistency:
                                page.set_tracks(new_metadata.tracks)
                
                print("DEBUG: Synchronous UI refresh complete.")
                return False
            
            GLib.idle_add(_do_instant_refresh)
            
        else:
            # Fallback to standard background sync for non-immediate updates
            def _sync_then_refresh():
                if hasattr(self, 'lib_manager'):
                    self.lib_manager.sync_library()
                    def _do_ui_refresh():
                        if hasattr(self, 'library_ui'): self.library_ui.refresh()
                        if hasattr(self, 'album_grid'): self.album_grid.refresh()
                        return False
                    GLib.idle_add(_do_ui_refresh)
            
            import threading
            threading.Thread(target=_sync_then_refresh, daemon=True).start()

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
    app = MusicApp(application_id="com.soundsible.player")
    app.run(None)
