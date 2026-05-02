## INSTALL – Advanced setup and deployment

This document covers scenarios beyond the basic local quick start in `README.md`.

Use this when you want to run Soundsible on a server, keep it running in the background, or expose it over your network.

### 1. System dependencies

Core requirements for the Station Engine and ODST downloader:

- Python 3.10+ and `git` (see `README.md` for virtual environment steps).
- FFmpeg – not bundled. Install via your OS package manager. Examples:
  - Debian/Ubuntu: `sudo apt install ffmpeg`
  - Arch: `sudo pacman -S ffmpeg`
  - Fedora: `sudo dnf install ffmpeg`
  - macOS: `brew install ffmpeg`
  - Windows: see the FFmpeg download page or use `winget install ffmpeg`.

Recommended or optional:

- A modern browser for the Station UI.
- Tailscale for secure remote access.
- NAS or object storage (R2/B2/S2) if you use those backends.

### 2. Running on a headless server

The steps are the same as for local installation, but executed over SSH.

1. SSH into your server and install Soundsible:

   ```bash
   git clone https://github.com/Arzuparreta/soundsible.git
   cd soundsible
   python3 -m venv venv
   ./venv/bin/pip install -r requirements.txt
   ```

2. Start the Station Engine using the CLI:

   ```bash
   ./venv/bin/python run.py
   ```

   Choose **Start Station Engine & Open Station**.

3. Access the Station UI from a browser on the same network:

   - `http://SERVER_LAN_IP:5005/player/`

4. To keep it running after you disconnect, use a process manager such as:

   - `systemd`
   - `supervisord`
   - A terminal multiplexer like `tmux` or `screen`

Configure these tools according to your usual operational standards.

### 3. Access over Tailscale

Soundsible works well with Tailscale for secure remote access without VPN configuration or port forwarding.

1. Install and log into Tailscale on the machine where Soundsible runs.
2. Start the Station Engine (via launcher or CLI).
3. From another device in your tailnet, open:

   ```text
   http://YOUR_TAILSCALE_IP:5005/player/
   ```

4. Optionally, install the web app on mobile (see `README.md` for PWA instructions).

### 4. Reverse proxy (optional)

You can serve Soundsible behind a reverse proxy such as Nginx, Caddy, or Traefik.

1. Run the Station Engine on its default port (`5005`).
2. Configure your proxy to forward a public path (for example `https://music.example.com`) to `http://127.0.0.1:5005`.
3. Ensure WebSocket and other long‑running connections are allowed by your proxy configuration.

Consult your proxy’s documentation for exact configuration snippets and TLS setup.

### 5. Storage considerations

By default, Soundsible uses local disk on the host. For larger libraries or shared setups:

- Mount a NAS path (for example NFS or SMB) and point the setup wizard at that location.
- Or configure an object storage backend (Cloudflare R2, Backblaze B2/R2, S2) via the setup wizard and configuration.

See `CONFIGURATION.md` for more details on storage‑related options.

### 6. Security baseline (LAN + Tailscale)

Soundsible is designed for trusted LAN/Tailscale deployments. Use this baseline:

1. **No public exposure**  
   Do not port-forward Station (`5005`) or Launcher (`5099`) to the public internet.

2. **Use Tailscale for remote access**  
   For outside-home access, prefer Tailscale instead of opening inbound router ports.

3. **Protect admin routes with a token**  
   Set:

   ```bash
   export SOUNDSIBLE_ADMIN_TOKEN='your-long-random-token'
   ```

   Then send that value as:
   - `Authorization: Bearer <token>` or
   - `X-Soundsible-Admin-Token: <token>`

4. **Launcher binding**  
   Launcher now binds to localhost by default for safer control-plane exposure.
   To intentionally allow LAN access to launcher UI, set:

   ```bash
   export SOUNDSIBLE_LAUNCHER_BIND_ALL=true
   ```

5. **CORS origin control**  
   By default, API CORS accepts localhost + private LAN + Tailscale browser origins.
   For tighter policy, explicitly set:

   ```bash
   export SOUNDSIBLE_ALLOWED_ORIGINS='http://localhost:5005,http://192.168.1.10:5005'
   export SOUNDSIBLE_SOCKET_CORS_ORIGINS='http://localhost:5005,http://192.168.1.10:5005'
   ```

