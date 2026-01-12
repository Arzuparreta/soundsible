import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')
from gi.repository import Gtk, Adw, Gio, GObject
from shared.constants import DEFAULT_CONFIG_DIR, DEFAULT_LIBRARY_PATH
from shared.models import PlayerConfig
from player.library import LibraryManager
from .library import LibraryView
import os
import json

class MusicApp(Adw.Application):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.connect('activate', self.on_activate)

    def on_activate(self, app):
        self.win = MainWindow(application=app)
        self.win.present()

class MainWindow(Adw.ApplicationWindow):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        
        self.set_title("Music Hub")
        self.set_default_size(1000, 700)
        
        # Main Layout
        main_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.set_content(main_box)
        
        # Header Bar
        header = Adw.HeaderBar()
        main_box.append(header)
        
        # Title
        title = Adw.WindowTitle(title="Music Hub", subtitle="Local Library")
        header.set_title_widget(title)

        # Content Area (Split View)
        # Initialize Library Manager
        # NOTE: In real app, do this async or with splash screen
        config = self._load_config()
        if config:
            self.lib_manager = LibraryManager()
            
            # Library View
            self.library_view = LibraryView(self.lib_manager)
            main_box.append(self.library_view)
            
            # Need to set expand so it fills space
            self.library_view.set_vexpand(True)
        else:
            error_label = Gtk.Label(label="Configuration not found. Please run setup-tool first.")
            main_box.append(error_label)
        
        # Bottom Player Bar
        player_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        player_bar.add_css_class("toolbar")
        player_bar.set_size_request(-1, 80)
        
        play_btn = Gtk.Button(icon_name="media-playback-start-symbolic")
        play_btn.add_css_class("circular")
        play_btn.set_halign(Gtk.Align.CENTER)
        
        player_bar.append(play_btn)
        # Center the button (rough layout)
        play_btn.set_hexpand(True) 
        
        main_box.append(player_bar)

    def _load_config(self):
        try:
            config_path = os.path.expanduser(os.path.join(DEFAULT_CONFIG_DIR, 'config.json'))
            if os.path.exists(config_path):
                with open(config_path, 'r') as f:
                    return PlayerConfig.from_json(f.read())
        except Exception as e:
            print(f"Error loading config: {e}")
        return None

if __name__ == "__main__":
    app = MusicApp(application_id="com.shmusichub.player")
    app.run(None)
