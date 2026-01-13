"""
First-run setup wizard for configuring cloud storage.
"""

import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')
from gi.repository import Gtk, Adw, GLib, Gio

from pathlib import Path
import json
from shared.models import StorageProvider, PlayerConfig
from shared.constants import DEFAULT_CONFIG_DIR
from setup_tool.provider_factory import StorageProviderFactory


class SetupWizard(Adw.Window):
    """Multi-page setup wizard for first-run configuration."""
    
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        
        self.set_title("Music Hub Setup")
        self.set_default_size(700, 550)
        self.set_modal(True)
        
        # Storage for wizard state
        self.selected_provider = None
        self.credentials = {}
        self.bucket_name = None
        self.config = None
        self.provider_instance = None
        
        # Create main layout
        self.main_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.set_content(self.main_box)
        
        # Header with progress
        self.create_header()
        
        # Content area (pages will switch here)
        self.content_stack = Gtk.Stack()
        self.content_stack.set_transition_type(Gtk.StackTransitionType.SLIDE_LEFT_RIGHT)
        self.content_stack.set_vexpand(True)
        self.main_box.append(self.content_stack)
        
        # Navigation buttons
        self.create_navigation()
        
        # Create pages
        self.create_pages()
        
        # Start with welcome page
        self.current_page_index = 0
        self.update_navigation()
    
    def create_header(self):
        """Create header with title and progress indicator."""
        header = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        header.set_margin_top(24)
        header.set_margin_bottom(12)
        header.set_margin_start(24)
        header.set_margin_end(24)
        
        title = Gtk.Label(label="Music Hub Setup")
        title.add_css_class("title-1")
        header.append(title)
        
        subtitle = Gtk.Label(label="Configure your cloud music storage")
        subtitle.add_css_class("dim-label")
        header.append(subtitle)
        
        self.progress = Gtk.ProgressBar()
        self.progress.set_fraction(0.0)
        header.append(self.progress)
        
        self.main_box.append(header)
    
    def create_navigation(self):
        """Create bottom navigation buttons."""
        nav_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        nav_box.set_margin_top(12)
        nav_box.set_margin_bottom(24)
        nav_box.set_margin_start(24)
        nav_box.set_margin_end(24)
        nav_box.set_halign(Gtk.Align.END)
        
        self.cancel_btn = Gtk.Button(label="Cancel")
        self.cancel_btn.connect('clicked', self.on_cancel_clicked)
        nav_box.append(self.cancel_btn)
        
        spacer = Gtk.Box()
        spacer.set_hexpand(True)
        nav_box.append(spacer)
        
        self.back_btn = Gtk.Button(label="Back")
        self.back_btn.connect('clicked', self.on_back_clicked)
        nav_box.append(self.back_btn)
        
        self.next_btn = Gtk.Button(label="Next")
        self.next_btn.add_css_class("suggested-action")
        self.next_btn.connect('clicked', self.on_next_clicked)
        nav_box.append(self.next_btn)
        
        self.main_box.append(nav_box)
    
    def create_pages(self):
        """Create all wizard pages."""
        self.pages = [
            self.create_welcome_page(),
            self.create_provider_page(),
            self.create_credentials_page(),
            self.create_bucket_page(),
            self.create_completion_page()
        ]
        
        for i, page in enumerate(self.pages):
            self.content_stack.add_named(page, f"page_{i}")
    
    def create_welcome_page(self):
        """Create welcome/introduction page."""
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=24)
        box.set_halign(Gtk.Align.CENTER)
        box.set_valign(Gtk.Align.CENTER)
        box.set_margin_top(48)
        box.set_margin_bottom(48)
        
        icon = Gtk.Image.new_from_icon_name("folder-music-symbolic")
        icon.set_pixel_size(128)
        icon.add_css_class("accent")
        box.append(icon)
        
        title = Gtk.Label(label="Welcome to Music Hub!")
        title.add_css_class("title-1")
        box.append(title)
        
        desc = Gtk.Label(
            label="This wizard will help you set up cloud storage\n"
                  "for your music library.\n\n"
                  "You'll need:"
        )
        desc.set_justify(Gtk.Justification.CENTER)
        box.append(desc)
        
        req_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        req_box.set_margin_start(48)
        req_box.set_margin_end(48)
        
        requirements = [
            "☁️ A cloud storage account (Cloudflare R2 or Backblaze B2)",
            "🔑 API credentials from your provider",
            "🎵 Your music files (optional - can upload later)"
        ]
        
        for req in requirements:
            label = Gtk.Label(label=req)
            label.set_xalign(0)
            req_box.append(label)
        
        box.append(req_box)
        return box
    
    def create_provider_page(self):
        """Create provider selection page."""
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=24)
        box.set_margin_top(24)
        box.set_margin_bottom(24)
        box.set_margin_start(48)
        box.set_margin_end(48)
        
        title = Gtk.Label(label="Choose Your Storage Provider")
        title.add_css_class("title-2")
        box.append(title)
        
        desc = Gtk.Label(label="Select where you want to store your music library")
        desc.add_css_class("dim-label")
        box.append(desc)
        
        cards_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        cards_box.set_margin_top(12)
        
        self.provider_group = None
        
        # Cloudflare R2
        r2_card = self.create_provider_card(
            "Cloudflare R2",
            "Best for streaming - zero bandwidth costs",
            "10GB free tier",
            StorageProvider.CLOUDFLARE_R2
        )
        cards_box.append(r2_card)
        
        # Backblaze B2
        b2_card = self.create_provider_card(
            "Backblaze B2",
            "Simplest setup - no credit card needed",
            "10GB free tier",
            StorageProvider.BACKBLAZE_B2
        )
        cards_box.append(b2_card)
        
        # Generic S3
        s3_card = self.create_provider_card(
            "Generic S3",
            "For advanced users with existing S3 storage",
            "Varies by provider",
            StorageProvider.GENERIC_S3
        )
        cards_box.append(s3_card)
        
        box.append(cards_box)
        return box
    
    def create_provider_card(self, name, description, free_tier, provider_enum):
        """Create a clickable provider selection card."""
        if self.provider_group is None:
            radio = Gtk.CheckButton(label=name)
            self.provider_group = radio
        else:
            radio = Gtk.CheckButton(label=name, group=self.provider_group)
        
        radio.provider = provider_enum
        radio.connect('toggled', self.on_provider_selected)
        
        card = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        card.add_css_class("card")
        card.set_margin_start(12)
        card.set_margin_end(12)
        card.set_margin_top(6)
        card.set_margin_bottom(6)
        
        card.append(radio)
        
        info_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        info_box.set_hexpand(True)
        
        desc_label = Gtk.Label(label=description)
        desc_label.set_xalign(0)
        desc_label.add_css_class("dim-label")
        info_box.append(desc_label)
        
        tier_label = Gtk.Label(label=f"Free tier: {free_tier}")
        tier_label.set_xalign(0)
        tier_label.add_css_class("caption")
        info_box.append(tier_label)
        
        card.append(info_box)
        return card
    
    def on_provider_selected(self, radio):
        """Handle provider selection."""
        if radio.get_active():
            self.selected_provider = radio.provider
            print(f"Selected provider: {self.selected_provider}")
    
    def create_credentials_page(self):
        """Create credentials input page."""
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=24)
        box.set_margin_top(24)
        box.set_margin_bottom(24)
        box.set_margin_start(48)
        box.set_margin_end(48)
        
        title = Gtk.Label(label="Enter Your API Credentials")
        title.add_css_class("title-2")
        box.append(title)
        
        self.creds_stack = Gtk.Stack()
        self.creds_stack.set_vexpand(True)
        
        self.creds_stack.add_named(self.create_r2_form(), "r2")
        self.creds_stack.add_named(self.create_b2_form(), "b2")
        self.creds_stack.add_named(self.create_s3_form(), "s3")
        
        box.append(self.creds_stack)
        return box
    
    def create_r2_form(self):
        """Create Cloudflare R2 credentials form."""
        form = Adw.PreferencesGroup()
        form.set_title("Cloudflare R2 - API Credentials")
        form.set_description("Get these from your Cloudflare dashboard → R2 → Manage API Tokens")
        
        self.r2_account_id = Adw.EntryRow()
        self.r2_account_id.set_title("Account ID")
        form.add(self.r2_account_id)
        
        self.r2_access_key = Adw.EntryRow()
        self.r2_access_key.set_title("Access Key ID")
        form.add(self.r2_access_key)
        
        self.r2_secret = Adw.PasswordEntryRow()
        self.r2_secret.set_title("Secret Access Key")
        form.add(self.r2_secret)
        
        return form
    
    def create_b2_form(self):
        """Create Backblaze B2 credentials form."""
        form = Adw.PreferencesGroup()
        form.set_title("Backblaze B2 - Application Key")
        form.set_description("Get these from your B2 dashboard → App Keys")
        
        self.b2_key_id = Adw.EntryRow()
        self.b2_key_id.set_title("Application Key ID")
        form.add(self.b2_key_id)
        
        self.b2_key = Adw.PasswordEntryRow()
        self.b2_key.set_title("Application Key")
        form.add(self.b2_key)
        
        return form
    
    def create_s3_form(self):
        """Create generic S3 credentials form."""
        form = Adw.PreferencesGroup()
        form.set_title("Generic S3 - Configuration")
        
        placeholder = Gtk.Label(label="S3 setup coming soon...")
        placeholder.add_css_class("dim-label")
        
        box = Gtk.Box()
        box.append(placeholder)
        return box
    
    def create_bucket_page(self):
        """Create bucket selection/creation page."""
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=24)
        box.set_margin_top(24)
        box.set_margin_bottom(24)
        box.set_margin_start(48)
        box.set_margin_end(48)
        
        title = Gtk.Label(label="Select or Create Bucket")
        title.add_css_class("title-2")
        box.append(title)
        
        desc = Gtk.Label(label="Choose an existing bucket or create a new one")
        desc.add_css_class("dim-label")
        box.append(desc)
        
        self.test_conn_btn = Gtk.Button(label="Test Connection & Load Buckets")
        self.test_conn_btn.add_css_class("suggested-action")
        self.test_conn_btn.connect('clicked', self.on_test_connection)
        box.append(self.test_conn_btn)
        
        self.conn_status = Gtk.Label(label="")
        self.conn_status.set_wrap(True)
        box.append(self.conn_status)
        
        bucket_form = Adw.PreferencesGroup()
        bucket_form.set_title("Bucket Selection")
        
        self.bucket_dropdown = Adw.ComboRow()
        self.bucket_dropdown.set_title("Existing Buckets")
        self.bucket_dropdown.set_subtitle("Select from your existing buckets")
        bucket_form.add(self.bucket_dropdown)
        
        self.new_bucket_entry = Adw.EntryRow()
        self.new_bucket_entry.set_title("Or Create New Bucket")
        self.new_bucket_entry.set_text("music-library")
        bucket_form.add(self.new_bucket_entry)
        
        self.public_toggle = Adw.SwitchRow()
        self.public_toggle.set_title("Make bucket publicly accessible")
        self.public_toggle.set_subtitle("Enable if you want direct file URLs")
        bucket_form.add(self.public_toggle)
        
        box.append(bucket_form)
        return box
    
    def on_test_connection(self, button):
        """Test connection and load buckets."""
        button.set_sensitive(False)
        self.conn_status.set_label("Testing connection...")
        GLib.idle_add(self._test_connection_async)
    
    def _test_connection_async(self):
        """Async connection test."""
        try:
            provider = StorageProviderFactory.create(self.selected_provider)
            
            if not provider.authenticate(self.credentials):
                self.conn_status.set_label("❌ Authentication failed. Check your credentials.")
                self.test_conn_btn.set_sensitive(True)
                return False
            
            buckets = provider.list_buckets()
            
            bucket_model = Gtk.StringList()
            for bucket in buckets:
                bucket_model.append(bucket['name'])
            
            self.bucket_dropdown.set_model(bucket_model)
            
            self.conn_status.set_label(f"✓ Connected! Found {len(buckets)} existing bucket(s).")
            self.provider_instance = provider
            
        except Exception as e:
            self.conn_status.set_label(f"❌ Connection failed: {str(e)}")
            self.test_conn_btn.set_sensitive(True)
        
        return False
    
    def create_completion_page(self):
        """Create success/completion page."""
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=24)
        box.set_halign(Gtk.Align.CENTER)
        box.set_valign(Gtk.Align.CENTER)
        
        icon = Gtk.Image.new_from_icon_name("emblem-ok-symbolic")
        icon.set_pixel_size(96)
        icon.add_css_class("success")
        box.append(icon)
        
        title = Gtk.Label(label="Setup Complete!")
        title.add_css_class("title-1")
        box.append(title)
        
        desc = Gtk.Label(label="Your cloud storage is configured.\nClick Finish to start using Music Hub!")
        desc.set_justify(Gtk.Justification.CENTER)
        box.append(desc)
        
        return box
    
    def update_navigation(self):
        """Update button states based on current page."""
        total_pages = len(self.pages)
        is_first = self.current_page_index == 0
        is_last = self.current_page_index == total_pages - 1
        
        self.progress.set_fraction((self.current_page_index + 1) / total_pages)
        self.back_btn.set_sensitive(not is_first)
        
        if is_last:
            self.next_btn.set_label("Finish")
        else:
            self.next_btn.set_label("Next")
        
        self.content_stack.set_visible_child_name(f"page_{self.current_page_index}")
        
        # Update credentials page based on selected provider
        if self.current_page_index == 2:
            if self.selected_provider == StorageProvider.CLOUDFLARE_R2:
                self.creds_stack.set_visible_child_name("r2")
            elif self.selected_provider == StorageProvider.BACKBLAZE_B2:
                self.creds_stack.set_visible_child_name("b2")
            elif self.selected_provider == StorageProvider.GENERIC_S3:
                self.creds_stack.set_visible_child_name("s3")
    
    def on_next_clicked(self, button):
        """Handle Next/Finish button click."""
        if self.current_page_index == len(self.pages) - 1:
            self.on_finish()
        else:
            if self.validate_current_page():
                self.current_page_index += 1
                self.update_navigation()
    
    def on_back_clicked(self, button):
        """Handle Back button click."""
        if self.current_page_index > 0:
            self.current_page_index -= 1
            self.update_navigation()
    
    def on_cancel_clicked(self, button):
        """Handle Cancel button click."""
        self.close()
    
    def validate_current_page(self):
        """Validate current page before advancing."""
        if self.current_page_index == 1:  # Provider page
            if not self.selected_provider:
                print("Please select a provider")
                return False
        
        elif self.current_page_index == 2:  # Credentials page
            if self.selected_provider == StorageProvider.CLOUDFLARE_R2:
                account_id = self.r2_account_id.get_text()
                access_key = self.r2_access_key.get_text()
                secret = self.r2_secret.get_text()
                
                if not all([account_id, access_key, secret]):
                    print("Please fill all fields")
                    return False
                
                self.credentials = {
                    'account_id': account_id,
                    'access_key_id': access_key,
                    'secret_access_key': secret
                }
                
            elif self.selected_provider == StorageProvider.BACKBLAZE_B2:
                key_id = self.b2_key_id.get_text()
                key = self.b2_key.get_text()
                
                if not all([key_id, key]):
                    print("Please fill all fields")
                    return False
                
                self.credentials = {
                    'application_key_id': key_id,
                    'application_key': key
                }
        
        elif self.current_page_index == 3:  # Bucket page
            # Get selected or new bucket
            selected_idx = self.bucket_dropdown.get_selected()
            new_bucket = self.new_bucket_entry.get_text().strip()
            
            if selected_idx != Gtk.INVALID_LIST_POSITION:
                # Use selected bucket
                model = self.bucket_dropdown.get_model()
                self.bucket_name = model.get_string(selected_idx)
            elif new_bucket:
                # Create new bucket
                self.bucket_name = new_bucket
            else:
                print("Please select or create a bucket")
                return False
        
        return True
    
    def on_finish(self):
        """Handle wizard completion."""
        # Determine endpoint based on provider
        if self.selected_provider == StorageProvider.CLOUDFLARE_R2:
            endpoint = f"https://{self.credentials['account_id']}.r2.cloudflarestorage.com"
        elif self.selected_provider == StorageProvider.BACKBLAZE_B2:
            endpoint = "s3.us-west-004.backblazeb2.com"  # Default, may need region selection
        else:
            endpoint = ""
        
        config = PlayerConfig(
            provider=self.selected_provider,
            endpoint=endpoint,
            bucket=self.bucket_name,
            access_key_id=self.credentials.get('access_key_id', self.credentials.get('application_key_id', '')),
            secret_access_key=self.credentials.get('secret_access_key', self.credentials.get('application_key', '')),
            region=self.credentials.get('region'),
            public=self.public_toggle.get_active()
        )
        
        config_dir = Path(DEFAULT_CONFIG_DIR).expanduser()
        config_dir.mkdir(parents=True, exist_ok=True)
        config_file = config_dir / "config.json"
        
        with open(config_file, 'w') as f:
            f.write(config.to_json())
        
        print(f"✓ Configuration saved to: {config_file}")
        self.close()
