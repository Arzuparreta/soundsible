## INSTALL – Advanced setup & deployment

This document covers scenarios beyond the basic local quick start in `README.md`.

### 1. Running on a server (headless)

1. SSH into your server and follow the same steps as local installation:

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

   Choose **Start Station Engine & Open Station**. The Station UI will be available at:

   - `http://SERVER_LAN_IP:5005/player/`

3. To keep it running after you disconnect, use a process manager such as `systemd`, `supervisord`, or `tmux`/`screen` according to your preference.

### 2. Access over Tailscale

Soundsible works well together with [Tailscale](https://github.com/tailscale/tailscale) to provide secure remote access without manual VPN or port forwarding.

1. Install and log into Tailscale on the machine where Soundsible runs.
2. Start the Station Engine (via launcher or CLI).
3. From another device in your tailnet, open:

   ```text
   http://YOUR_TAILSCALE_IP:5005/player/
   ```

4. Optionally, install the web app on mobile (see `README.md` for PWA instructions).

### 3. Reverse proxy (optional)

If you want to serve Soundsible behind a reverse proxy (e.g. Nginx, Caddy, Traefik):

1. Run the Station Engine on its default port (`5005`).
2. Configure your proxy to forward a public path (for example `https://music.example.com`) to `http://127.0.0.1:5005`.
3. Ensure websockets and long‑running connections are allowed by your proxy configuration.

Consult your proxy’s documentation for exact configuration snippets.

### 4. Storage considerations

By default, Soundsible uses local disk on the host. For larger libraries or shared setups:

- Mount a NAS path (e.g. NFS, SMB) and configure it during the setup wizard.
- Or point Soundsible to an object storage backend (Cloudflare R2, Backblaze B2/R2, S2) via the setup wizard and configuration.

See [CONFIGURATION.md](CONFIGURATION.md) for more details on storage‑related options.

