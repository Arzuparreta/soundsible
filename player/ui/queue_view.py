"""
Queue View Widget - Displays the current playback queue.
"""

from gi.repository import Gtk, GLib, Gdk
from player.queue_manager import QueueManager
from typing import Optional


class QueueView(Gtk.Box):
    """
    Widget displaying the current playback queue.
    Shows queued tracks and allows removal of individual items.
    """
    
    def __init__(self, queue_manager: QueueManager):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.queue_manager = queue_manager
        
        # Header
        header_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        header_box.set_margin_top(6)
        header_box.set_margin_bottom(6)
        header_box.set_margin_start(12)
        header_box.set_margin_end(12)
        
        header_label = Gtk.Label(label="Queue")
        header_label.add_css_class("heading")
        header_label.set_halign(Gtk.Align.START)
        header_label.set_hexpand(True)
        header_box.append(header_label)
        
        self.count_label = Gtk.Label(label="0")
        self.count_label.add_css_class("dim-label")
        self.count_label.set_halign(Gtk.Align.END)
        header_box.append(self.count_label)
        
        self.append(header_box)
        
        # Separator
        self.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))
        
        # Scrolled window for queue items
        scroller = Gtk.ScrolledWindow()
        scroller.set_vexpand(True)
        scroller.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        
        # ListBox for queue items
        self.list_box = Gtk.ListBox()
        self.list_box.add_css_class("navigation-sidebar")
        self.list_box.set_selection_mode(Gtk.SelectionMode.NONE)
        scroller.set_child(self.list_box)
        
        self.append(scroller)
        
        # Empty state
        self.empty_label = Gtk.Label(label="Queue is empty")
        self.empty_label.add_css_class("dim-label")
        self.empty_label.set_margin_top(50)
        self.empty_label.set_margin_bottom(50)
        
        # Register for queue changes
        self.queue_manager.add_change_callback(self._on_queue_changed)
        
        # Initial population
        self._refresh_ui()
    
    def _on_queue_changed(self):
        """Callback when queue contents change."""
        # Schedule UI update on main thread
        GLib.idle_add(self._refresh_ui)
    
    def _refresh_ui(self):
        """Refresh the queue display."""
        # Clear existing items
        while True:
            row = self.list_box.get_row_at_index(0)
            if row is None:
                break
            self.list_box.remove(row)
        
        # Get current queue
        tracks = self.queue_manager.get_all()
        
        # Update count
        self.count_label.set_label(str(len(tracks)))
        
        if not tracks:
            # Show empty state
            self.list_box.append(self.empty_label)
        else:
            # Populate with tracks
            for idx, track in enumerate(tracks):
                row = self._create_queue_row(track, idx)
                self.list_box.append(row)
        
        return False  # Remove from idle queue
    
    def _create_queue_row(self, track, index: int):
        """Create a row widget for a queue item."""
        row = Gtk.ListBoxRow()
        row.set_activatable(False)
        
        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        box.set_margin_top(6)
        box.set_margin_bottom(6)
        box.set_margin_start(12)
        box.set_margin_end(12)
        
        # Track number
        num_label = Gtk.Label(label=f"{index + 1}.")
        num_label.add_css_class("dim-label")
        num_label.set_width_chars(3)
        num_label.set_xalign(1.0)
        box.append(num_label)
        
        # Track info
        info_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        info_box.set_hexpand(True)
        
        title_label = Gtk.Label(label=track.title)
        title_label.set_xalign(0)
        title_label.set_ellipsize(3)  # Pango.EllipsizeMode.END
        info_box.append(title_label)
        
        artist_label = Gtk.Label(label=track.artist)
        artist_label.set_xalign(0)
        artist_label.add_css_class("dim-label")
        artist_label.add_css_class("caption")
        artist_label.set_ellipsize(3)
        info_box.append(artist_label)
        
        box.append(info_box)
        
        # Remove button
        remove_btn = Gtk.Button()
        remove_btn.set_icon_name("user-trash-symbolic")
        remove_btn.add_css_class("flat")
        remove_btn.add_css_class("circular")
        remove_btn.set_valign(Gtk.Align.CENTER)
        remove_btn.connect('clicked', lambda btn: self._on_remove_clicked(index))
        box.append(remove_btn)
        
        row.set_child(box)

        # Right-click gesture for the row
        right_click = Gtk.GestureClick()
        right_click.set_button(3)
        right_click.connect("pressed", lambda g, n, x, y: self._on_row_right_click(g, x, y, index))
        row.add_controller(right_click)

        return row
    
    def _on_row_right_click(self, gesture, x, y, index):
        gesture.set_state(Gtk.EventSequenceState.CLAIMED)
        
        p = Gtk.Popover()
        p.set_parent(gesture.get_widget())
        p.set_has_arrow(False)
        p.set_autohide(True)
        p.add_css_class("context-menu")

        rect = Gdk.Rectangle()
        rect.x, rect.y, rect.width, rect.height = int(x), int(y), 1, 1
        p.set_pointing_to(rect)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        btn = Gtk.Button(label="Remove from Queue")
        btn.add_css_class("flat")
        btn.set_halign(Gtk.Align.START)
        btn.connect("clicked", lambda b: (p.popdown(), self._on_remove_clicked(index)))
        box.append(btn)
        
        p.set_child(box)
        p.popup()

    def _on_remove_clicked(self, index: int):
        """Handle remove button click."""
        self.queue_manager.remove(index)
