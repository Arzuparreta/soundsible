from gi.repository import Gtk, GObject, Gio, Pango, GLib, Gdk

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

from setup_tool.metadata import search_itunes, download_image
import threading

class EditTrackDialog(Gtk.Window):
    def __init__(self, parent, track, library_manager):
        super().__init__(modal=True, transient_for=parent)
        self.set_title("Edit Metadata")
        self.set_default_size(500, 400)
        
        self.track = track
        self.library_manager = library_manager
        self.cover_path = None
        
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        box.set_margin_top(20)
        box.set_margin_bottom(20)
        box.set_margin_start(20)
        box.set_margin_end(20)
        self.set_child(box)
        
        # Grid for fields
        grid = Gtk.Grid()
        grid.set_row_spacing(10)
        grid.set_column_spacing(10)
        box.append(grid)
        
        # Title
        grid.attach(Gtk.Label(label="Title:", xalign=1), 0, 0, 1, 1)
        self.title_entry = Gtk.Entry(text=track.title)
        self.title_entry.set_hexpand(True)
        grid.attach(self.title_entry, 1, 0, 1, 1)
        
        # Artist
        grid.attach(Gtk.Label(label="Artist:", xalign=1), 0, 1, 1, 1)
        self.artist_entry = Gtk.Entry(text=track.artist)
        grid.attach(self.artist_entry, 1, 1, 1, 1)
        
        # Album
        grid.attach(Gtk.Label(label="Album:", xalign=1), 0, 2, 1, 1)
        self.album_entry = Gtk.Entry(text=track.album)
        grid.attach(self.album_entry, 1, 2, 1, 1)
        
        # Cover Art Section
        box.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))
        
        cover_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        box.append(cover_box)
        
        self.cover_img = Gtk.Image()
        self.cover_img.set_pixel_size(100)
        self.cover_img.set_size_request(100, 100)
        self.cover_img.add_css_class("card")
        self.cover_img.set_from_icon_name("emblem-music-symbolic")
        cover_box.append(self.cover_img)
        
        btn_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        btn_box.set_valign(Gtk.Align.CENTER)
        cover_box.append(btn_box)
        
        auto_btn = Gtk.Button(label="Auto-Fetch Cover")
        auto_btn.set_icon_name("system-search-symbolic")
        auto_btn.connect('clicked', self.on_auto_fetch)
        btn_box.append(auto_btn)
        
        select_btn = Gtk.Button(label="Select from File...")
        select_btn.connect('clicked', self.on_select_file)
        btn_box.append(select_btn)
        
        # Status
        self.status = Gtk.Label(label="")
        box.append(self.status)
        
        # Action Buttons
        actions = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        actions.set_halign(Gtk.Align.END)
        actions.set_margin_top(10)
        box.append(actions)
        
        cancel = Gtk.Button(label="Cancel")
        cancel.connect('clicked', lambda x: self.close())
        actions.append(cancel)
        
        self.save_btn = Gtk.Button(label="Save & Update")
        self.save_btn.add_css_class("suggested-action")
        self.save_btn.connect('clicked', self.on_save)
        actions.append(self.save_btn)
        
    def on_auto_fetch(self, btn):
        self.status.set_label("Searching...")
        query = f"{self.artist_entry.get_text()} {self.title_entry.get_text()}"
        threading.Thread(target=self._search_thread, args=(query,), daemon=True).start()
        
    def _search_thread(self, query):
        try:
            results = search_itunes(query, limit=1)
            if results:
                url = results[0]['artwork_url']
                data = download_image(url)
                if data:
                    import tempfile
                    with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as tmp:
                        tmp.write(data)
                        path = tmp.name
                    GLib.idle_add(self._update_preview, path)
            else:
                GLib.idle_add(lambda: self.status.set_label("No covers found."))
        except Exception as e:
            print(e)
            
    def _update_preview(self, path):
        self.cover_path = path
        try:
            import gi.repository.GdkPixbuf as GdkPixbuf
            pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 100, 100, True)
            self.cover_img.set_from_pixbuf(pixbuf)
            self.status.set_label("Cover found!")
        except:
            self.cover_img.set_from_file(path)
            
    def on_select_file(self, btn):
        dialog = Gtk.FileDialog()
        dialog.open(parent=self, callback=self.on_file_chosen)
        
    def on_file_chosen(self, dialog, result):
        try:
            f = dialog.open_finish(result)
            if f:
                self._update_preview(f.get_path())
        except: pass

    def on_save(self, btn):
        self.save_btn.set_sensitive(False)
        self.status.set_label("Updating track... This involves uploading.")
        
        new_meta = {
            'title': self.title_entry.get_text(),
            'artist': self.artist_entry.get_text(),
            'album': self.album_entry.get_text()
        }
        
        threading.Thread(target=self._save_thread, args=(new_meta,), daemon=True).start()
        
    def _save_thread(self, meta):
        success = self.library_manager.update_track(self.track, meta, self.cover_path)
        if success:
            # Sync library to get latest version
            self.library_manager.sync_library()
        GLib.idle_add(self.on_save_complete, success)
        
    def on_save_complete(self, success):
        if success:
            self.close()
        else:
            self.status.set_label("Update failed. Check logs.")
            self.save_btn.set_sensitive(True)

class LibraryView(Gtk.Box):
    def __init__(self, library_manager, on_track_activated=None):
        super().__init__(orientation=Gtk.Orientation.VERTICAL)
        self.library_manager = library_manager
        self.on_track_activated = on_track_activated

        # Setup List Model
        self.store = Gio.ListStore(item_type=TrackObject)
        self._populate_library()
        
        # 3. Setup Filter Model
        self.filter = Gtk.CustomFilter()
        self.filter.set_filter_func(self._filter_func)
        self.filter_model = Gtk.FilterListModel(model=self.store, filter=self.filter)
        self.search_query = ""  # Store current search query

        # 4. Setup Selection Model
        # Single selection for now
        self.selection_model = Gtk.SingleSelection(model=self.filter_model)
        self.selection_model.connect('selection-changed', self.on_selection_changed)

        # 5. Create Column View
        self.column_view = Gtk.ColumnView(model=self.selection_model)
        self.column_view.add_css_class("rich-list") # Adwaita style class
        
        # Columns - Add cover art first
        self._add_cover_column()
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
        
        # Right Click Menu
        click_gesture = Gtk.GestureClick()
        click_gesture.set_button(3) # Right mouse button
        click_gesture.connect("pressed", self.on_right_click)
        self.column_view.add_controller(click_gesture)

    def on_right_click(self, gesture, n_press, x, y):
        # We need to find which item was clicked. 
        # ColumnView is tricky for hit testing in GTK4 without extensive boilerplate.
        # Strategy: Use the currently SELECTED item (assuming right click also selects or user selected first)
        
        selected_obj = self.selection_model.get_selected_item()
        if not selected_obj:
            return
            
        # Create Popover
        menu = Gio.Menu()
        menu.append("Edit Metadata / Fix Cover", "edit")
        
        popover = Gtk.PopoverMenu.new_from_model(menu)
        popover.set_parent(self.column_view)
        
        # We can't easily position at x,y content on ColumnView without more work.
        # Position at the mouse for now? Gtk.Popover allows set_pointing_to
        
        rect = Gdk.Rectangle()
        rect.x = int(x)
        rect.y = int(y)
        rect.width = 1
        rect.height = 1
        popover.set_pointing_to(rect)
        popover.set_has_arrow(False)
        
        # Action handler
        # Since we can't easily bind GActionGroup to a ephemeral popover manually 
        # (needs to be on widget), we'll cheat and use a custom box popover instead of Menu
        
        p = Gtk.Popover()
        p.set_parent(self.column_view)
        p.set_pointing_to(rect)
        
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        btn = Gtk.Button(label="Edit Metadata / Fix Cover")
        btn.add_css_class("flat")
        btn.set_halign(Gtk.Align.START)
        btn.connect('clicked', lambda b: self._open_edit_dialog(p, selected_obj.track))
        box.append(btn)
        
        p.set_child(box)
        p.popup()
    
    def _on_search_changed(self, entry):
        """Handle search query changes."""
        self.search_query = entry.get_text().lower().strip()
        # Trigger filter update
        self.filter.changed(Gtk.FilterChange.DIFFERENT)
    
    def _filter_func(self, track_obj):
        """Filter function to match tracks against search query."""
        if not self.search_query:
            return True  # Show all when no search
        
        track = track_obj.track
        # Search in title, artist, and album (case-insensitive)
        return (self.search_query in track.title.lower() or
                self.search_query in track.artist.lower() or
                self.search_query in track.album.lower())
        
    def _open_edit_dialog(self, popover, track):
        popover.popdown()
        dialog = EditTrackDialog(self.get_root(), track, self.library_manager)
        dialog.present()
        
    def _add_cover_column(self):
        """Add cover art thumbnail column."""
        factory = Gtk.SignalListItemFactory()
        
        def on_setup(factory, list_item):
            image = Gtk.Image()
            image.set_pixel_size(32)
            image.set_size_request(32, 32)
            list_item.set_child(image)
        
        def on_bind(factory, list_item):
            image = list_item.get_child()
            track_obj = list_item.get_item()
            
            # Try to load cover art
            self._load_cover_thumbnail(image, track_obj.track)
        
        factory.connect("setup", on_setup)
        factory.connect("bind", on_bind)
        
        column = Gtk.ColumnViewColumn(title="", factory=factory)
        column.set_fixed_width(40)
        self.column_view.append_column(column)
    
    def _load_cover_thumbnail(self, image, track):
        """Load cover art thumbnail for a track."""
        import threading
        from setup_tool.audio import AudioProcessor
        from gi.repository import GdkPixbuf
        import tempfile
        import os
        
        def load_in_background():
            try:
                # Check if track is cached
                if self.library_manager.cache:
                    cached = self.library_manager.cache.get_cached_path(track.id)
                    if cached and os.path.exists(cached):
                        # Extract cover
                        cover_data = AudioProcessor.extract_cover_art(cached)
                        if cover_data:
                            # Save to temp and load
                            with tempfile.NamedTemporaryFile(delete=False, suffix='.jpg') as tmp:
                                tmp.write(cover_data)
                                tmp_path = tmp.name
                            
                            try:
                                pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
                                    tmp_path, 32, 32, True
                                )
                                GLib.idle_add(image.set_from_pixbuf, pixbuf)
                            finally:
                                os.remove(tmp_path)
                            return
                
                # No cover or not cached - show default icon
                GLib.idle_add(image.set_from_icon_name, "emblem-music-symbolic")
            except Exception as e:
                GLib.idle_add(image.set_from_icon_name, "emblem-music-symbolic")
        
        # Start background loading
        threading.Thread(target=load_in_background, daemon=True).start()
    
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
        """Initiate asynchronous library loading to avoid blocking UI."""
        # Show loading state
        self.loading_label = Gtk.Label(label="Loading library...")
        self.loading_label.add_css_class("title-2")
        self.loading_label.set_margin_top(50)
        self.loading_label.set_margin_bottom(50)
        self.append(self.loading_label)
        
        # Load in background using GLib thread pool
        import threading
        thread = threading.Thread(target=self._load_library_thread, daemon=True)
        thread.start()

    def _load_library_thread(self):
        """Background thread for library loading (non-UI thread)."""
        try:
            if self.library_manager.sync_library():
                tracks = self.library_manager.metadata.tracks
                print(f"Found {len(tracks)} tracks in library.")
                
                # Update UI on main thread
                GLib.idle_add(self._populate_ui, tracks)
            else:
                GLib.idle_add(self._show_error, "Failed to sync library or library is empty.")
        except Exception as e:
            GLib.idle_add(self._show_error, f"Error loading library: {e}")

    def _populate_ui(self, tracks):
        """Populate UI with tracks (called on main thread)."""
        # Remove loading indicator
        if hasattr(self, 'loading_label') and self.loading_label.get_parent():
            self.remove(self.loading_label)
        
        # Batch UI updates for better performance
        self.store.freeze_notify()
        try:
            for track in tracks:
                self.store.append(TrackObject(track))
        finally:
            self.store.thaw_notify()
        
        return False  # Remove from idle queue

    def _show_error(self, message):
        """Show error message in UI (called on main thread)."""
        # Remove loading indicator if present
        if hasattr(self, 'loading_label') and self.loading_label.get_parent():
            self.remove(self.loading_label)
        
        error_label = Gtk.Label(label=message)
        error_label.add_css_class("error")
        error_label.set_margin_top(50)
        self.append(error_label)
        
        print(f"Library Error: {message}")
        return False  # Remove from idle queue

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
            if self.on_track_activated:
                self.on_track_activated(selected_obj.track)
