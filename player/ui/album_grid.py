from gi.repository import Gtk, GObject, Gio, Pango, GLib, Gdk, GdkPixbuf
import os
from shared.constants import DEFAULT_CACHE_DIR
from player.cover_manager import CoverFetchManager

class AlbumObject(GObject.Object):
    """GObject wrapper for Album metadata."""
    __gtype_name__ = 'AlbumObject'
    
    @GObject.Property(type=str)
    def album(self): return self._data['album']
    
    @GObject.Property(type=str)
    def artist(self): return self._data['artist']
    
    @GObject.Property(type=int)
    def track_count(self): return self._data['track_count']

    def __init__(self, data):
        super().__init__()
        self._data = data

class AlbumCard(Gtk.Box):
    def __init__(self, album_obj, on_click_callback, library_manager):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self.album_obj = album_obj
        self.library_manager = library_manager
        self.on_click_callback = on_click_callback
        
        self.add_css_class("card")
        self.add_css_class("album-card")
        self.set_margin_top(8)
        self.set_margin_bottom(8)
        self.set_margin_start(8)
        self.set_margin_end(8)
        self.set_size_request(180, 240)
        
        # Image
        self.img = Gtk.Image()
        self.img.set_pixel_size(164)
        self.img.set_size_request(164, 164)
        self.img.add_css_class("album-cover")
        self.img.set_from_icon_name("emblem-music-symbolic")
        self.append(self.img)
        
        # Title
        self.title = Gtk.Label(label=album_obj.album, xalign=0)
        self.title.add_css_class("heading")
        self.title.set_ellipsize(Pango.EllipsizeMode.END)
        
        # Use Pango attributes for bold weight
        attr_list = Pango.AttrList()
        attr_list.insert(Pango.attr_weight_new(Pango.Weight.BOLD))
        self.title.set_attributes(attr_list)
        
        self.append(self.title)
        
        # Artist
        self.artist = Gtk.Label(label=album_obj.artist, xalign=0)
        self.artist.add_css_class("caption")
        self.artist.set_ellipsize(Pango.EllipsizeMode.END)
        self.append(self.artist)
        
        # Click handler
        click = Gtk.GestureClick()
        click.connect("released", self._on_clicked)
        self.add_controller(click)
        
        # Right click handler
        right_click = Gtk.GestureClick()
        right_click.set_button(3) # Right mouse button
        right_click.connect("pressed", self._on_right_click)
        self.add_controller(right_click)
        
        # Load Cover
        GLib.idle_add(self._load_cover)

    def _on_right_click(self, gesture, n_press, x, y):
        gesture.set_state(Gtk.EventSequenceState.CLAIMED)
        
        p = Gtk.Popover()
        p.set_parent(self)
        p.set_has_arrow(False)
        p.set_autohide(True)
        p.add_css_class("context-menu")

        rect = Gdk.Rectangle()
        rect.x, rect.y, rect.width, rect.height = int(x), int(y), 1, 1
        p.set_pointing_to(rect)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        
        def add_item(label, callback):
            btn = Gtk.Button(label=label)
            btn.add_css_class("flat")
            btn.set_halign(Gtk.Align.START)
            btn.connect("clicked", lambda b: (p.popdown(), callback()))
            box.append(btn)

        def play_album():
            tracks = self.library_manager.db.get_tracks_by_album(self.album_obj.album, self.album_obj.artist)
            if tracks:
                root = self.get_root()
                if root and hasattr(root, 'play_track'):
                    if hasattr(root, 'queue_manager'):
                        root.queue_manager.clear()
                        for t in tracks[1:]: root.queue_manager.add(t)
                    root.play_track(tracks[0])

        def queue_album():
            tracks = self.library_manager.db.get_tracks_by_album(self.album_obj.album, self.album_obj.artist)
            root = self.get_root()
            if root and hasattr(root, 'queue_manager'):
                for t in tracks: root.queue_manager.add(t)

        add_item("Play Album", play_album)
        add_item("Add Album to Queue", queue_album)

        p.set_child(box)
        p.popup()

    def _on_clicked(self, gesture, n_press, x, y):
        if self.on_click_callback:
            tracks = self.library_manager.db.get_tracks_by_album(self.album_obj.album, self.album_obj.artist)
            self.on_click_callback(self.album_obj, tracks)

    def _load_cover(self):
        track_id = self.album_obj._data['first_track_id']
        manager = CoverFetchManager.get_instance()
        
        from shared.models import Track
        stub_track = Track(
            id=track_id,
            title="", artist=self.album_obj.artist, album=self.album_obj.album,
            duration=0, file_hash="", original_filename="",
            compressed=False, file_size=0, bitrate=0, format="mp3"
        )
        
        def on_fetched(pixbuf):
            if pixbuf:
                scaled = pixbuf.scale_simple(164, 164, GdkPixbuf.InterpType.BILINEAR)
                GLib.idle_add(self.img.set_from_pixbuf, scaled)
                
        manager.request_cover(stub_track, callback=on_fetched)

class AlbumGridView(Gtk.Box):
    def __init__(self, library_manager, on_album_activated=None):
        super().__init__(orientation=Gtk.Orientation.VERTICAL)
        self.library_manager = library_manager
        self.on_album_activated = on_album_activated
        
        self.flow_box = Gtk.FlowBox()
        self.flow_box.set_valign(Gtk.Align.START)
        self.flow_box.set_max_children_per_line(10)
        self.flow_box.set_selection_mode(Gtk.SelectionMode.NONE)
        self.flow_box.add_css_class("album-grid")
        
        scroller = Gtk.ScrolledWindow()
        scroller.set_child(self.flow_box)
        scroller.set_vexpand(True)
        self.append(scroller)
        
        self.refresh()

    def refresh(self):
        # Clear
        while child := self.flow_box.get_first_child():
            self.flow_box.remove(child)
            
        # Repopulate
        albums = self.library_manager.db.get_albums()
        for a in albums:
            album_obj = AlbumObject(a)
            card = AlbumCard(album_obj, self.on_album_activated, self.library_manager)
            self.flow_box.append(card)

    def _load_album_cover(self, image, album_obj):
        image.set_from_icon_name("emblem-music-symbolic")
        
        # Get a representative track ID for this album
        track_id = album_obj._data['first_track_id']
        
        manager = CoverFetchManager.get_instance()
        
        # Prepare track stub for manager
        from shared.models import Track
        stub_track = Track(
            id=track_id,
            title="", artist=album_obj.artist, album=album_obj.album,
            duration=0, file_hash="", original_filename="",
            compressed=False, file_size=0, bitrate=0, format="mp3"
        )
        
        def on_fetched(pixbuf):
            if pixbuf:
                # Scale for grid
                scaled = pixbuf.scale_simple(160, 160, GdkPixbuf.InterpType.BILINEAR)
                GLib.idle_add(image.set_from_pixbuf, scaled)
                
        manager.request_cover(stub_track, callback=on_fetched)

    def _on_activated(self, grid_view, position):
        album_obj = self.store.get_item(position)
        if self.on_album_activated:
            tracks = self.library_manager.db.get_tracks_by_album(album_obj.album, album_obj.artist)
            self.on_album_activated(album_obj, tracks)
