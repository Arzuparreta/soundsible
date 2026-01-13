"""
Custom circular volume knob widget for the music player.

Provides a rotary control for volume adjustment with smooth visual feedback.
"""

import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, Gdk, GObject
import math
import cairo


class VolumeKnob(Gtk.DrawingArea):
    """
    A circular volume knob widget with mouse and scroll interaction.
    
    Signals:
        value-changed: Emitted when the volume value changes
    """
    
    __gsignals__ = {
        'value-changed': (GObject.SignalFlags.RUN_FIRST, None, (float,))
    }
    
    def __init__(self, initial_value=100.0):
        super().__init__()
        
        # Value properties
        self._value = max(0.0, min(100.0, initial_value))
        self._min_value = 0.0
        self._max_value = 100.0
        
        # Visual properties
        self._size = 56  # Increased to prevent clipping
        self._knob_radius = 18
        self._track_width = 4
        self._hovering = False
        self._dragging = False
        
        # Angle range (in radians): -135° to +135° (270° total)
        self._angle_min = -3 * math.pi / 4  # -135°
        self._angle_max = 3 * math.pi / 4   # +135°
        
        # Setup widget
        self.set_size_request(self._size, self._size)
        self.set_content_width(self._size)
        self.set_content_height(self._size)
        self.set_draw_func(self._on_draw)
        
        # Mouse events
        self._setup_event_controllers()
    
    def _setup_event_controllers(self):
        """Setup mouse and scroll event controllers."""
        # Drag gesture for rotation
        drag = Gtk.GestureDrag()
        drag.connect('drag-begin', self._on_drag_begin)
        drag.connect('drag-update', self._on_drag_update)
        drag.connect('drag-end', self._on_drag_end)
        self.add_controller(drag)
        
        # Scroll for fine adjustment
        scroll = Gtk.EventControllerScroll()
        scroll.set_flags(Gtk.EventControllerScrollFlags.VERTICAL)
        scroll.connect('scroll', self._on_scroll)
        self.add_controller(scroll)
        
        # Hover detection
        motion = Gtk.EventControllerMotion()
        motion.connect('enter', self._on_enter)
        motion.connect('leave', self._on_leave)
        self.add_controller(motion)
    
    def _on_draw(self, area, cr, width, height):
        """Draw the volume knob using Cairo."""
        center_x = width / 2
        center_y = height / 2
        
        # Calculate current angle based on value
        value_ratio = (self._value - self._min_value) / (self._max_value - self._min_value)
        current_angle = self._angle_min + value_ratio * (self._angle_max - self._angle_min)
        
        # Colors (adapt to dark theme)
        bg_color = (0.2, 0.2, 0.2)
        track_bg_color = (0.3, 0.3, 0.3)
        track_fill_color = (0.4, 0.6, 1.0)  # Blue accent
        knob_color = (0.35, 0.35, 0.35)
        indicator_color = (1.0, 1.0, 1.0)
        
        if self._hovering:
            knob_color = (0.4, 0.4, 0.4)
        if self._dragging:
            knob_color = (0.45, 0.45, 0.45)
        
        # Draw background circle
        cr.set_source_rgb(*bg_color)
        cr.arc(center_x, center_y, self._knob_radius + 6, 0, 2 * math.pi)
        cr.fill()
        
        # Draw track background arc
        cr.set_line_width(self._track_width)
        cr.set_source_rgb(*track_bg_color)
        cr.arc(center_x, center_y, self._knob_radius + 6, 
               self._angle_min - math.pi / 2, 
               self._angle_max - math.pi / 2)
        cr.stroke()
        
        # Draw filled track (progress)
        if self._value > self._min_value:
            cr.set_line_width(self._track_width)
            cr.set_source_rgb(*track_fill_color)
            cr.arc(center_x, center_y, self._knob_radius + 6,
                   self._angle_min - math.pi / 2,
                   current_angle - math.pi / 2)
            cr.stroke()
        
        # Draw main knob circle
        cr.set_source_rgb(*knob_color)
        cr.arc(center_x, center_y, self._knob_radius, 0, 2 * math.pi)
        cr.fill()
        
        # Draw knob indicator line
        indicator_length = self._knob_radius - 4
        indicator_x = center_x + math.cos(current_angle - math.pi / 2) * indicator_length
        indicator_y = center_y + math.sin(current_angle - math.pi / 2) * indicator_length
        
        cr.set_source_rgb(*indicator_color)
        cr.set_line_width(2)
        cr.move_to(center_x, center_y)
        cr.line_to(indicator_x, indicator_y)
        cr.stroke()
        
        # Draw center dot
        cr.set_source_rgb(*indicator_color)
        cr.arc(center_x, center_y, 2, 0, 2 * math.pi)
        cr.fill()
    
    def _on_drag_begin(self, gesture, start_x, start_y):
        """Handle drag start."""
        self._dragging = True
        self._drag_start_value = self._value  # Store starting value
        self.queue_draw()
    
    def _on_drag_update(self, gesture, offset_x, offset_y):
        """Handle drag update - use combined movement to adjust volume."""
        # Combine both horizontal and vertical movement
        # Right/Up = increase, Left/Down = decrease
        # Sensitivity: moving ~200 pixels = full range (0-100)
        sensitivity = 0.35  # Reduced by 30% for more precise control
        
        # Combine offsets: right is positive, up is negative (so negate y)
        # This makes dragging right OR up increase volume
        combined_offset = offset_x + (-offset_y)
        delta = combined_offset * sensitivity
        
        # Calculate new value based on drag from initial position
        if not hasattr(self, '_drag_start_value'):
            self._drag_start_value = self._value
        
        new_value = self._drag_start_value + delta
        self.set_value(new_value)
    
    def _on_drag_end(self, gesture, offset_x, offset_y):
        """Handle drag end."""
        self._dragging = False
        if hasattr(self, '_drag_start_value'):
            delattr(self, '_drag_start_value')  # Clean up
        self.queue_draw()
    
    def _on_scroll(self, controller, dx, dy):
        """Handle scroll wheel - adjust volume."""
        # Scroll up = increase, scroll down = decrease
        delta = -dy * 5  # Sensitivity
        new_value = self._value + delta
        self.set_value(new_value)
        return True
    
    def _on_enter(self, controller, x, y):
        """Handle mouse enter."""
        self._hovering = True
        self.queue_draw()
    
    def _on_leave(self, controller):
        """Handle mouse leave."""
        self._hovering = False
        self.queue_draw()
    
    def set_value(self, value):
        """
        Set the knob value.
        
        Args:
            value: New value (will be clamped to min/max range)
        """
        old_value = self._value
        self._value = max(self._min_value, min(self._max_value, value))
        
        if abs(old_value - self._value) > 0.01:
            self.queue_draw()
            self.emit('value-changed', self._value)
    
    def get_value(self):
        """Get current knob value."""
        return self._value
    
    @GObject.Property(type=float, default=100.0)
    def value(self):
        """Volume value property (0-100)."""
        return self._value
    
    @value.setter
    def value(self, val):
        self.set_value(val)
