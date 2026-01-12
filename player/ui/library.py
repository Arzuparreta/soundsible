from gi.repository import Gtk, GObject, Gio, Pango

class TrackObject(GObject.Object):
    """
    GObject wrapper for our Track model so it can be used in Gtk.ListStore
    """
    __gtype_name__ = 'TrackObject'
    
    def __init__(self, track):
        super().__init__()
        self.track = track
        # Expose properties for binding if needed, 
        # but for simple CellFactories we can access .track directly

    @GObject.Property(type=str)
    def title(self):
        return self.track.title

    @GObject.Property(type=str)
    def artist(self):
        return self.track.artist

    @GObject.Property(type=str)
    def album(self):
        return self.track.album

class LibraryView(Gtk.Box):
    def __init__(self, library_manager):
        super().__init__(orientation=Gtk.Orientation.VERTICAL)
        self.library_manager = library_manager
        
        # 1. Screen Title / Search (Mockup)
        # top_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        # top_bar.append(Gtk.Label(label="Library"))
        # self.append(top_bar)

        # 2. Setup List Model
        self.store = Gio.ListStore(item_type=TrackObject)
        self._populate_library()

        # 3. Setup Selection Model
        # Single selection for now
        self.selection_model = Gtk.SingleSelection(model=self.store)
        self.selection_model.connect('selection-changed', self.on_selection_changed)

        # 4. Create Column View
        self.column_view = Gtk.ColumnView(model=self.selection_model)
        self.column_view.add_css_class("rich-list") # Adwaita style class
        
        # Columns
        self._add_text_column("Title", "title", expand=True)
        self._add_text_column("Artist", "artist")
        self._add_text_column("Album", "album")
        self._add_text_column("Length", "duration", fixed_width=80) 

        # Scroll Window
        scroller = Gtk.ScrolledWindow()
        scroller.set_child(self.column_view)
        scroller.set_vexpand(True)
        self.append(scroller)

        # Signal for playback when row activated (double click)
        self.column_view.connect("activate", self.on_row_activated)

    def _add_text_column(self, title, property_name, expand=False, fixed_width=0):
        factory = Gtk.SignalListItemFactory()
        
        # Create Label
        def on_setup(factory, list_item):
            label = Gtk.Label(xalign=0)
            label.set_ellipsize(Pango.EllipsizeMode.END)
            list_item.set_child(label)
            
        # Bind Data
        def on_bind(factory, list_item):
            label = list_item.get_child()
            track_obj = list_item.get_item() # This is our TrackObject
            
            # Helper to format duration if that's the property
            if property_name == "duration":
                val = self._format_duration(track_obj.track.duration)
            else:
                val = getattr(track_obj, property_name, "")
                
            label.set_text(str(val))

        factory.connect("setup", on_setup)
        factory.connect("bind", on_bind)
        
        column = Gtk.ColumnViewColumn(title=title, factory=factory)
        if expand:
            column.set_expand(True)
        if fixed_width > 0:
            column.set_fixed_width(fixed_width)
            
        self.column_view.append_column(column)

    def _populate_library(self):
        # Async loading would be better, but doing sync strictly for prototype
        try:
            self.library_manager.sync() 
            tracks = self.library_manager.library.tracks
            
            # Bulk append? ListStore doesn't strictly have bulk, but simpleloop is fine for <1000 items
            for track in tracks:
                self.store.append(TrackObject(track))
                
        except Exception as e:
            print(f"Error loading library: {e}")

    def _format_duration(self, seconds):
        if not seconds: return "--:--"
        m, s = divmod(int(seconds), 60)
        return f"{m}:{s:02d}"

    def on_selection_changed(self, model, position, n_items):
        pass # Placeholder

    def on_row_activated(self, view, position):
        selected_obj = self.selection_model.get_selected_item()
        if selected_obj:
            print(f"Playing: {selected_obj.title}")
            # Fire event or call controller to play this track ID
            # For now, we print.
