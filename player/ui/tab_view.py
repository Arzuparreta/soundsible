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
        self.add_css_class("tab-view")
        
        # Create stack for content
        self.stack = Gtk.Stack()
        self.stack.add_css_class("tab-view-stack")
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
    
    def add_page(self, child: Gtk.Widget, name: str, label: str, visible: bool = True, closable: bool = False, insert_before: str = None):
        """Add a page to the stack with a tab button."""
        # Add to stack
        self.stack.add_named(child, name)
        
        # Create tab container (Box)
        tab_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        tab_box.add_css_class("tab-container")
        
        # Create tab button
        button = Gtk.Button(label=label)
        button.add_css_class("flat")
        button.add_css_class("tab-button")
        button.connect('clicked', lambda b: self._on_tab_clicked(name))
        tab_box.append(button)
        
        # Add close button if closable
        if closable:
            close_btn = Gtk.Button(icon_name="window-close-symbolic")
            close_btn.add_css_class("flat")
            close_btn.add_css_class("tab-close-button")
            close_btn.set_tooltip_text(f"Close {label}")
            close_btn.connect('clicked', lambda b: self.remove_page(name))
            tab_box.append(close_btn)
        
        # Store metadata
        self.tabs_metadata[name] = {
            'label': label,
            'container': tab_box,
            'button': button,
            'visible': visible,
            'child': child,
            'closable': closable
        }
        
        # Add to tabs bar if visible
        if visible:
            if insert_before and insert_before in self.tabs_metadata:
                # Find the widget to insert before
                sibling = self.tabs_metadata[insert_before]['container']
                # To insert before sibling, we need to know what's BEFORE sibling
                # In GTK4 GtkBox, we use insert_child_after.
                
                # Logic to insert before:
                # Get children of tabs_bar
                children = []
                curr = self.tabs_bar.get_first_child()
                while curr:
                    children.append(curr)
                    curr = curr.get_next_sibling()
                
                try:
                    idx = children.index(sibling)
                    if idx == 0:
                        self.tabs_bar.prepend(tab_box)
                    else:
                        self.tabs_bar.insert_child_after(tab_box, children[idx-1])
                except ValueError:
                    self.tabs_bar.append(tab_box)
            else:
                self.tabs_bar.append(tab_box)
        
        # If this is the first page, make it active
        if len(self.tabs_metadata) == 1:
            button.add_css_class("active-tab")
            self.stack.set_visible_child_name(name)
    
    def remove_page(self, name: str):
        """Remove a page and its tab button."""
        if name not in self.tabs_metadata:
            return
            
        metadata = self.tabs_metadata[name]
        
        # If active, switch to another tab first
        if self.stack.get_visible_child_name() == name:
            self._switch_to_next_available_tab(name)
            
        # Remove from tabs bar
        self.tabs_bar.remove(metadata['container'])
        
        # Remove from stack
        self.stack.remove(metadata['child'])
        
        # Remove from metadata
        del self.tabs_metadata[name]

    def _switch_to_next_available_tab(self, current_name: str):
        """Switch to another visible tab when the current one is being removed."""
        names = list(self.tabs_metadata.keys())
        try:
            idx = names.index(current_name)
            # Try next one
            for i in range(idx + 1, len(names)):
                if self.tabs_metadata[names[i]]['visible']:
                    self._on_tab_clicked(names[i])
                    return
            # Try previous ones
            for i in range(idx - 1, -1, -1):
                if self.tabs_metadata[names[i]]['visible']:
                    self._on_tab_clicked(names[i])
                    return
        except ValueError:
            pass
        
        # Fallback to first visible
        self._switch_to_first_visible_tab()

    def set_tab_visible(self, name: str, visible: bool):
        """Show or hide a tab."""
        if name not in self.tabs_metadata:
            return
        
        metadata = self.tabs_metadata[name]
        if metadata['visible'] == visible:
            return  # No change needed
        
        metadata['visible'] = visible
        container = metadata['container']
        
        if visible:
            # Add container to tabs bar
            self.tabs_bar.append(container)
        else:
            # Remove container from tabs bar
            self.tabs_bar.remove(container)
            
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
