## INSTALL – Advanced setup and deployment

### Desktop (Beta) — normal users start here

**Install an app, pick a music folder, play.** No Python, git, or terminal on the happy path.

- Status and validation checklist: **[DESKTOP_BETA.md](./DESKTOP_BETA.md)**
- Maintainer/dev build: [desktop-shell/README.md](../desktop-shell/README.md)
- Releases: GitHub **Releases** artifacts tagged `desktop-v*` (when published)

The sections below are for **Advanced** self-hosting (server, NAS, Docker, Tailscale, systemd).

---

This document covers scenarios beyond the desktop beta and the basic local quick start in `README.md`.

Use this when you want to run Soundsible on a server, keep it running in the background, or expose it over your network.

This document is primarily about the legacy/headless deployment path. The desktop appliance runtime uses the Tauri shell + engine sidecar (or `python3 run.py --desktop-engine` for contributors), binds loopback on a random port, and is documented in `README.md` and `ARCHITECTURE.md`.

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
   sudo apt update
   sudo apt install -y python3.12-venv python3-pip ffmpeg git
   git clone https://github.com/Arzuparreta/soundsible.git
   cd soundsible
   python3 run.py
   ```

   `run.py` is the supported bootstrap path. It creates the project venv, repairs a partial/broken one, installs Python requirements, and then starts the launcher.

2. Start the Station Engine using the CLI:

   ```bash
   python3 run.py
   ```

   Choose **Start Station Engine & Open Station**.

3. Access the Station UI from a browser on the same network:

   - `http://SERVER_LAN_IP:5005/player/`

4. To keep it running after you disconnect, use a process manager such as:

   - `systemd`
   - `supervisord`
   - A terminal multiplexer like `tmux` or `screen`

Configure these tools according to your usual operational standards.

### 2B. Legacy fixed-port assumptions

Most examples in this document assume the legacy daemon path:

- `python3 run.py --daemon`
- host/network exposure on port `5005`
- browser access via `/player/`

That is still the correct path for:

- SSH and server installs
- systemd/supervisord/tmux usage
- reverse proxies
- Tailscale/LAN access from other devices

The desktop-sidecar path should not be treated as a drop-in replacement for those examples yet because it binds loopback on a random port by default.

### 3. Access over Tailscale

Soundsible works well with Tailscale for secure remote access without VPN configuration or port forwarding.

1. Install and log into Tailscale on the machine where Soundsible runs.
2. Start the Station Engine (via launcher or CLI).
3. From another device in your tailnet, open:

   ```text
   http://YOUR_TAILSCALE_IP:5005/player/
   ```

4. Optionally, install the web app on mobile (see `README.md` for PWA instructions).

If you want the newer pairing-based flow instead of typing URLs manually, use the desktop player at `/player/desktop/` on the desktop runtime path. The pairing APIs and desktop pairing modal are present, but the full packaged desktop shell is still in progress.

### 4. Reverse proxy (optional)

You can serve Soundsible behind a reverse proxy such as Nginx, Caddy, or Traefik.

1. Run the Station Engine on its default port (`5005`).
2. Configure your proxy to forward a public path (for example `https://music.example.com`) to `http://127.0.0.1:5005`.
3. Ensure WebSocket and other long‑running connections are allowed by your proxy configuration.

Do not reverse-proxy the desktop-sidecar random loopback port directly as a public endpoint. Keep reverse proxy guidance tied to the legacy daemon/server path for now.

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

   In desktop-engine mode, Soundsible also creates a short owner token file and injects that token into `/player/desktop/` automatically. That path is meant for the embedded/local desktop UI, not for public browser sessions.

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
