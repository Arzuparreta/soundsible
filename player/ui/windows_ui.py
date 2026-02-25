"""
Soundsible Windows Control Center
A lightweight Tkinter-based dashboard for managing the media server.
"""

import tkinter as tk
from tkinter import ttk, messagebox, filedialog
import threading
import webbrowser
import os
import sys
import socket
import time
from pathlib import Path
from PIL import Image, ImageTk
import pystray
from pystray import MenuItem as item

class WindowsControlCenter:
    def __init__(self, launcher):
        self.launcher = launcher
        self.root = tk.Tk()
        self.root.title("Soundsible Control Center")
        self.root.geometry("500x450")
        self.root.resizable(False, False)
        
        # Tray setup
        self.tray_icon = None
        self.root.protocol('WM_DELETE_WINDOW', self.minimize_to_tray)
        
        # Styles
        style = ttk.Style()
        style.configure("Status.TLabel", font=("Segoe UI", 10))
        style.configure("Header.TLabel", font=("Segoe UI", 14, "bold"))
        style.configure("Big.TButton", font=("Segoe UI", 10), padding=10)
        
        self.setup_ui()
        self.update_loop_active = True
        
    def setup_ui(self):
        # Main Container
        main = ttk.Frame(self.root, padding="20")
        main.pack(fill=tk.BOTH, expand=True)
        
        # Header
        header = ttk.Label(main, text="Soundsible Station", style="Header.TLabel")
        header.pack(pady=(0, 20))
        
        # Status Card
        status_frame = ttk.LabelFrame(main, text=" Server Status ", padding="15")
        status_frame.pack(fill=tk.X, pady=10)
        
        self.api_status_label = ttk.Label(status_frame, text="Backend API: Checking...", style="Status.TLabel")
        self.api_status_label.pack(anchor=tk.W)
        
        self.ip_label = ttk.Label(status_frame, text="Local IP: Detecting...", style="Status.TLabel")
        self.ip_label.pack(anchor=tk.W, pady=(5, 0))
        
        # Quick Actions
        actions_frame = ttk.Frame(main, padding="10")
        actions_frame.pack(fill=tk.X, pady=20)
        
        btn_open_player = ttk.Button(actions_frame, text="Open Web Player", style="Big.TButton", command=self.open_player)
        btn_open_player.pack(fill=tk.X, pady=5)
        
        btn_open_odst = ttk.Button(actions_frame, text="Download Music (ODST)", style="Big.TButton", command=self.open_downloader)
        btn_open_odst.pack(fill=tk.X, pady=5)
        
        btn_sync = ttk.Button(actions_frame, text="Sync to Mobile (QR)", style="Big.TButton", command=self.show_sync_qr)
        btn_sync.pack(fill=tk.X, pady=5)
        
        # Bottom Bar
        bottom = ttk.Frame(main)
        bottom.pack(side=tk.BOTTOM, fill=tk.X)
        
        ttk.Button(bottom, text="Settings", command=self.open_settings).pack(side=tk.LEFT)
        ttk.Button(bottom, text="Exit", command=self.quit_app).pack(side=tk.RIGHT)

    def open_player(self):
        webbrowser.open("http://localhost:5005/player/")

    def open_downloader(self):
        """Open the embedded downloader in the main webapp (ensure API is running on 5005)."""
        webbrowser.open("http://localhost:5005/player/")

    def show_sync_qr(self):
        """Show sync QR code using the same logic as the Linux app."""
        import json
        import zlib
        import base64
        import segno
        import io
        
        from player.library import LibraryManager
        lib = LibraryManager(silent=True)
        config = lib.config
        
        if not config:
            messagebox.showerror("Error", "No Configuration Found. Run setup first.")
            return

        # Detect IPs
        tailscale_ip = None
        local_ip = "localhost"
        try:
            import subprocess
            ts_out = subprocess.check_output(["tailscale", "ip", "-4"], shell=True).decode().strip()
            if ts_out: tailscale_ip = ts_out
        except: pass

        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            local_ip = s.getsockname()[0]
            s.close()
        except: local_ip = "localhost"
        
        lan_url = f"http://{local_ip}:5005/player/"
        ts_url = f"http://{tailscale_ip}:5005/player/" if tailscale_ip else None

        # 1. Generate Token
        config_data = config.to_dict()
        from shared.api import get_active_endpoints
        config_data['endpoints'] = get_active_endpoints()
        config_data['port'] = 5005
        
        json_bytes = json.dumps(config_data).encode('utf-8')
        compressed = zlib.compress(json_bytes)
        token = base64.urlsafe_b64encode(compressed).decode('utf-8')
        
        # 2. Generate QR
        qr = segno.make(token)
        out = io.BytesIO()
        qr.save(out, kind='png', scale=5)
        
        # 3. Show Window
        qr_win = tk.Toplevel(self.root)
        qr_win.title("Sync to Mobile")
        qr_win.geometry("400x600")
        qr_win.resizable(False, False)
        qr_win.transient(self.root)
        
        tk.Label(qr_win, text="Link Your Phone", font=("Segoe UI", 12, "bold")).pack(pady=10)
        
        if ts_url:
            tk.Label(qr_win, text="Universal (Tailscale - Recommended):", font=("Segoe UI", 9, "bold")).pack()
            tk.Label(qr_win, text=ts_url, fg="#10b981", cursor="hand2", font=("Consolas", 11, "bold")).pack()
            tk.Label(qr_win, text="Use this ALWAYS if you have Tailscale.", font=("Segoe UI", 8, "bold")).pack()
            tk.Label(qr_win, text="Works everywhere (home & away) seamlessly.", font=("Segoe UI", 8), fg="gray").pack(pady=(0, 10))

        label_prefix = "Local (Wi-Fi Only - Legacy):" if ts_url else "At Home (Wi-Fi):"
        tk.Label(qr_win, text=label_prefix, font=("Segoe UI", 9, "bold")).pack()
        tk.Label(qr_win, text=lan_url, fg="#3b82f6", cursor="hand2", font=("Consolas", 10)).pack()
        if ts_url:
            tk.Label(qr_win, text="Only use this if you don't have Tailscale.", font=("Segoe UI", 8), fg="gray").pack()
        
        img = Image.open(out)
        img_tk = ImageTk.PhotoImage(img)
        qr_label = tk.Label(qr_win, image=img_tk)
        qr_label.image = img_tk # Keep reference
        qr_label.pack(pady=20)
        
        tk.Label(qr_win, text="Paste this token in your phone's Settings:", font=("Segoe UI", 9)).pack()
        token_text = tk.Text(qr_win, height=4, width=40, font=("Consolas", 8))
        token_text.insert(tk.END, token)
        token_text.config(state=tk.DISABLED)
        token_text.pack(pady=10, padx=20)
        
        ttk.Button(qr_win, text="Close", command=qr_win.destroy).pack(pady=10)

    def open_settings(self):
        SettingsWindow(self.root, self.launcher)

    def minimize_to_tray(self):
        self.root.withdraw()
        if not self.tray_icon:
            self.create_tray_icon()

    def create_tray_icon(self):
        # Use placeholder icon
        icon_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "ui_web", "assets", "icons", "icon-192.png")
        if os.path.exists(icon_path):
            image = Image.open(icon_path)
        else:
            image = Image.new('RGB', (64, 64), color='blue')
            
        menu = (
            item('Open Dashboard', self.show_window),
            item('Open Player', self.open_player),
            item('Sync to Mobile', self.show_sync_qr),
            item('Quit', self.quit_app)
        )
        self.tray_icon = pystray.Icon("soundsible", image, "Soundsible", menu)
        threading.Thread(target=self.tray_icon.run, daemon=True).start()

    def show_window(self):
        if self.tray_icon:
            self.tray_icon.stop()
            self.tray_icon = None
        self.root.after(0, self.root.deiconify)

    def quit_app(self):
        self.update_loop_active = False
        if self.tray_icon:
            self.tray_icon.stop()
        self.root.destroy()
        self.launcher.cleanup()
        sys.exit(0)

class SettingsWindow(tk.Toplevel):
    def __init__(self, parent, launcher):
        super().__init__(parent)
        self.launcher = launcher
        self.title("Soundsible Settings")
        self.geometry("450x500")
        self.resizable(False, False)
        self.transient(parent)
        self.grab_set()
        
        self.config = self.load_config()
        self.setup_ui()

    def load_config(self):
        from player.library import LibraryManager
        lib = LibraryManager(silent=True)
        return lib.config

    def setup_ui(self):
        tabs = ttk.Notebook(self)
        tabs.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)
        
        # --- Local Tab ---
        local_tab = ttk.Frame(tabs, padding=15)
        tabs.add(local_tab, text=" Local / NAS ")
        
        ttk.Label(local_tab, text="Watched Music Folders:", font=("Segoe UI", 9, "bold")).pack(anchor=tk.W)
        self.folder_list = tk.Listbox(local_tab, height=8)
        self.folder_list.pack(fill=tk.X, pady=5)
        
        if self.config:
            for folder in self.config.watch_folders:
                self.folder_list.insert(tk.END, folder)
            
        btn_box = ttk.Frame(local_tab)
        btn_box.pack(fill=tk.X)
        ttk.Button(btn_box, text="Add Folder", command=self.add_folder).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_box, text="Remove", command=self.remove_folder).pack(side=tk.LEFT, padx=2)
        
        # --- Cloud Tab ---
        cloud_tab = ttk.Frame(tabs, padding=15)
        tabs.add(cloud_tab, text=" Cloud Storage ")
        
        ttk.Label(cloud_tab, text="Provider:").grid(row=0, column=0, sticky=tk.W, pady=5)
        self.provider_var = tk.StringVar(value=self.config.provider.value if self.config else "r2")
        provider_cb = ttk.Combobox(cloud_tab, textvariable=self.provider_var, values=["r2", "b2", "s3"])
        provider_cb.grid(row=0, column=1, sticky=tk.EW, pady=5)
        
        ttk.Label(cloud_tab, text="Bucket Name:").grid(row=1, column=0, sticky=tk.W, pady=5)
        self.bucket_entry = ttk.Entry(cloud_tab)
        if self.config: self.bucket_entry.insert(0, self.config.bucket)
        self.bucket_entry.grid(row=1, column=1, sticky=tk.EW, pady=5)
        
        ttk.Label(cloud_tab, text="Access Key ID:").grid(row=2, column=0, sticky=tk.W, pady=5)
        self.key_entry = ttk.Entry(cloud_tab)
        if self.config: self.key_entry.insert(0, self.config.access_key_id)
        self.key_entry.grid(row=2, column=1, sticky=tk.EW, pady=5)
        
        ttk.Label(cloud_tab, text="Secret Key:").grid(row=3, column=0, sticky=tk.W, pady=5)
        self.secret_entry = ttk.Entry(cloud_tab, show="*")
        if self.config: self.secret_entry.insert(0, self.config.secret_access_key)
        self.secret_entry.grid(row=3, column=1, sticky=tk.EW, pady=5)
        
        ttk.Label(cloud_tab, text="Endpoint (R2):").grid(row=4, column=0, sticky=tk.W, pady=5)
        self.endpoint_entry = ttk.Entry(cloud_tab)
        if self.config: self.endpoint_entry.insert(0, self.config.endpoint)
        self.endpoint_entry.grid(row=4, column=1, sticky=tk.EW, pady=5)
        
        cloud_tab.columnconfigure(1, weight=1)
        
        # Save Button
        save_btn = ttk.Button(self, text="Save & Apply", command=self.save_settings)
        save_btn.pack(pady=15)

    def add_folder(self):
        folder = filedialog.askdirectory()
        if folder:
            self.folder_list.insert(tk.END, folder)

    def remove_folder(self):
        idx = self.folder_list.curselection()
        if idx:
            self.folder_list.delete(idx)

    def save_settings(self):
        from shared.models import StorageProvider
        # Update config object
        self.config.provider = StorageProvider(self.provider_var.get())
        self.config.bucket = self.bucket_entry.get()
        self.config.access_key_id = self.key_entry.get()
        self.config.secret_access_key = self.secret_entry.get()
        self.config.endpoint = self.endpoint_entry.get()
        self.config.watch_folders = list(self.folder_list.get(0, tk.END))
        
        # Save to disk
        from shared.constants import DEFAULT_CONFIG_DIR
        config_file = Path(DEFAULT_CONFIG_DIR).expanduser() / "config.json"
        with open(config_file, 'w') as f:
            f.write(self.config.to_json())
            
        messagebox.showinfo("Success", "Settings saved. Restart Soundsible to apply changes.")
        self.destroy()

    def check_status(self):
        while self.update_loop_active:
            # Check API (Port 5005)
            api_online = False
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.settimeout(0.5)
                    api_online = s.connect_ex(('127.0.0.1', 5005)) == 0
            except: pass
            
            # Update UI safely
            status_text = "Backend API: ONLINE" if api_online else "Backend API: OFFLINE (Starting...)"
            
            # Get IP
            try:
                hostname = socket.gethostname()
                ip = socket.gethostbyname(hostname)
            except: ip = "Unknown"
            
            self.root.after(0, lambda: self.api_status_label.config(text=status_text))
            self.root.after(0, lambda: self.ip_label.config(text=f"Local IP: {ip}"))
            
            # If offline and not started, start it
            if not api_online:
                self.launcher.launch_web_player()
                
            time.sleep(5)

    def run(self):
        # Start status monitor thread
        threading.Thread(target=self.check_status, daemon=True).start()
        self.root.mainloop()
