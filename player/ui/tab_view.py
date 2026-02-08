"""
Tab View Widget - Custom tabbed interface for library views.
"""

from gi.repository import Gtk, GLib
from typing import Optional, Callable


class TabView(Gtk.Box):
    """
    Custom tabbed view with thin text-only tabs.
    Supports auto-hiding tabs based on conditions.
    """
    
    def __init__(self):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        
        # Create stack for content
        self.stack = Gtk.Stack()
        self.stack.set_transition_type(Gtk.StackTransitionType.NONE)
        self.stack.set_transition_duration(0)
        self.stack.set_vexpand(True)
        
        # Tab metadata
        self.tabs_metadata = {}  # page_name -> {label, button, visible}
        
        # Tabs bar (custom implementation for thin tabs)
        self.tabs_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        self.tabs_bar.add_css_class("tabs-bar")
        self.tabs_bar.set_homogeneous(False)
        
        # Content goes first, tabs below
        self.append(self.stack)
        self.append(self.tabs_bar)
    
    def add_page(self, child: Gtk.Widget, name: str, label: str, visible: bool = True):
        """Add a page to the stack with a tab button."""
        # Add to stack
        self.stack.add_named(child, name)
        
        # Create tab button
        button = Gtk.Button(label=label)
        button.add_css_class("flat")
        button.add_css_class("tab-button")
        button.connect('clicked', lambda b: self._on_tab_clicked(name))
        
        # Store metadata
        self.tabs_metadata[name] = {
            'label': label,
            'button': button,
            'visible': visible,
            'child': child
        }
        
        # Add to tabs bar if visible
        if visible:
            self.tabs_bar.append(button)
        
        # If this is the first page, make it active
        if len(self.tabs_metadata) == 1:
            button.add_css_class("active-tab")
            self.stack.set_visible_child_name(name)
    
    def set_tab_visible(self, name: str, visible: bool):
        """Show or hide a tab."""
        if name not in self.tabs_metadata:
            return
        
        metadata = self.tabs_metadata[name]
        if metadata['visible'] == visible:
            return  # No change needed
        
        metadata['visible'] = visible
        button = metadata['button']
        
        if visible:
            # Add button to tabs bar
            self.tabs_bar.append(button)
        else:
            # Remove button from tabs bar
            self.tabs_bar.remove(button)
            
            # If this tab was active, switch to first visible tab
            if self.stack.get_visible_child_name() == name:
                self._switch_to_first_visible_tab()
    
    def get_visible_child_name(self) -> Optional[str]:
        """Get the name of the currently visible page."""
        return self.stack.get_visible_child_name()
    
    def set_visible_child_name(self, name: str):
        """Switch to a specific page."""
        if name in self.tabs_metadata and self.tabs_metadata[name]['visible']:
            self._on_tab_clicked(name)
    
    def get_page(self, name: str) -> Optional[Gtk.Widget]:
        """Get the widget for a specific page."""
        if name in self.tabs_metadata:
            return self.tabs_metadata[name]['child']
        return None
    
    def _on_tab_clicked(self, name: str):
        """Handle tab button click."""
        # Update active state on buttons
        for tab_name, metadata in self.tabs_metadata.items():
            if tab_name == name:
                metadata['button'].add_css_class("active-tab")
            else:
                metadata['button'].remove_css_class("active-tab")
        
        # Switch to page
        self.stack.set_visible_child_name(name)
    
    def _switch_to_first_visible_tab(self):
        """Switch to the first visible tab."""
        for name, metadata in self.tabs_metadata.items():
            if metadata['visible']:
                self._on_tab_clicked(name)
                return
