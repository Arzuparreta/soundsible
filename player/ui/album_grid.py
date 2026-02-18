from gi.repository import Gtk, GObject, Gio, Pango, GLib, Gdk, GdkPixbuf
import os
from shared.constants import DEFAULT_CACHE_DIR
from player.cover_manager import CoverFetchManager

# Fixed column count for equal-width grid cells (webapp-style)
ALBUM_GRID_COLUMNS = 4
ALBUM_TILE_SIZE = 160
ALBUM_GRID_GAP = 24


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
    """Minimal album item: one rounded cover tile + text below. No card container (webapp artist-grid style)."""
    def __init__(self, album_obj, on_click_callback, library_manager):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.album_obj = album_obj
        self.library_manager = library_manager
        self.on_click_callback = on_click_callback

        self.set_size_request(ALBUM_TILE_SIZE, -1)
        self.set_hexpand(False)
        self.set_vexpand(False)

        # Cover: single Gtk.Picture = the only visible "tile" (rounded, shadow, border via .album-tile)
        self.img = Gtk.Picture()
        self.img.set_content_fit(Gtk.ContentFit.COVER)
        self.img.set_can_shrink(False)
        self.img.set_size_request(ALBUM_TILE_SIZE, ALBUM_TILE_SIZE)
        self.img.set_hexpand(False)
        self.img.set_vexpand(False)
        self.img.add_css_class("album-tile")
        theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default())
        icon_paintable = theme.lookup_icon("emblem-music-symbolic", None, ALBUM_TILE_SIZE, 1, Gtk.TextDirection.LTR, 0)
        if icon_paintable:
            self.img.set_paintable(icon_paintable)
        self.append(self.img)

        # Text below (mt-4 px-2 style): wrapper for margin only
        text_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        text_box.add_css_class("album-card-text")
        self.title = Gtk.Label(label=album_obj.album, xalign=0)
        self.title.add_css_class("album-card-title")
        self.title.set_ellipsize(Pango.EllipsizeMode.END)
        attr_list = Pango.AttrList()
        attr_list.insert(Pango.attr_weight_new(Pango.Weight.BOLD))
        self.title.set_attributes(attr_list)
        text_box.append(self.title)
        self.artist = Gtk.Label(label=album_obj.artist, xalign=0)
        self.artist.add_css_class("album-card-caption")
        self.artist.set_ellipsize(Pango.EllipsizeMode.END)
        text_box.append(self.artist)
        self.append(text_box)

        click = Gtk.GestureClick()
        click.connect("released", self._on_clicked)
        self.add_controller(click)
        right_click = Gtk.GestureClick()
        right_click.set_button(3)
        right_click.connect("pressed", self._on_right_click)
        self.add_controller(right_click)

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
                scaled = pixbuf.scale_simple(ALBUM_TILE_SIZE, ALBUM_TILE_SIZE, GdkPixbuf.InterpType.BILINEAR)
                texture = Gdk.Texture.new_for_pixbuf(scaled)
                GLib.idle_add(self.img.set_paintable, texture)

        manager.request_cover(stub_track, callback=on_fetched, size=300)


class AlbumGridView(Gtk.Box):
    def __init__(self, library_manager, on_album_activated=None):
        super().__init__(orientation=Gtk.Orientation.VERTICAL)
        self.library_manager = library_manager
        self.on_album_activated = on_album_activated

        self.grid = Gtk.Grid()
        self.grid.set_row_spacing(ALBUM_GRID_GAP)
        self.grid.set_column_spacing(ALBUM_GRID_GAP)
        self.grid.add_css_class("album-grid")

        scroller = Gtk.ScrolledWindow()
        scroller.set_child(self.grid)
        scroller.set_vexpand(True)
        self.append(scroller)

        self.refresh()
        GLib.timeout_add_seconds(30, self._periodic_refresh)

    def _periodic_refresh(self):
        if self.get_mapped():
            self.refresh()
        return True

    def refresh(self):
        if hasattr(self.library_manager, 'refresh_if_stale'):
            self.library_manager.refresh_if_stale()
        while child := self.grid.get_first_child():
            self.grid.remove(child)
        albums = self.library_manager.db.get_albums()
        for i, a in enumerate(albums):
            album_obj = AlbumObject(a)
            card = AlbumCard(album_obj, self.on_album_activated, self.library_manager)
            row, col = divmod(i, ALBUM_GRID_COLUMNS)
            self.grid.attach(card, col, row, 1, 1)

    def set_albums(self, album_data):
        while child := self.grid.get_first_child():
            self.grid.remove(child)
        for i, a in enumerate(album_data):
            album_obj = AlbumObject(a)
            card = AlbumCard(album_obj, self.on_album_activated, self.library_manager)
            row, col = divmod(i, ALBUM_GRID_COLUMNS)
            self.grid.attach(card, col, row, 1, 1)
