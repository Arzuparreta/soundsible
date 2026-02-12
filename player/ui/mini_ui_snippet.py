
def _init_mini_player_ui(self):
    """Initialize the Mini Player view for small windows."""
    mini_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
    mini_box.set_valign(Gtk.Align.CENTER)
    mini_box.set_halign(Gtk.Align.CENTER)
    mini_box.set_spacing(16)
    
    # 1. Large Cover Art
    self.mini_cover = Gtk.Image()
    self.mini_cover.set_pixel_size(240)
    self.mini_cover.set_size_request(240, 240)
    self.mini_cover.add_css_class("card")
    self.mini_cover.set_from_icon_name("emblem-music-symbolic")
    # Ensure it's centered
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
    self.mini_scale.connect('value-changed', self.on_seek) # Reuse seek handler
    mini_box.append(self.mini_scale)
    
    # Time Label (optional but good)
    self.mini_time_label = Gtk.Label(label="--:--")
    self.mini_time_label.add_css_class("caption")
    mini_box.append(self.mini_time_label)

    # 4. Controls
    controls = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=24)
    controls.set_halign(Gtk.Align.CENTER)
    
    # Prev
    prev = Gtk.Button(icon_name="media-skip-backward-symbolic")
    prev.add_css_class("circular")
    prev.add_css_class("large-button") # Maybe define this style
    prev.connect('clicked', self.play_previous)
    controls.append(prev)
    
    # Play/Pause
    self.mini_play_btn = Gtk.Button(icon_name="media-playback-start-symbolic")
    self.mini_play_btn.add_css_class("circular")
    self.mini_play_btn.add_css_class("play-button") 
    self.mini_play_btn.set_size_request(64, 64) # Big button
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
