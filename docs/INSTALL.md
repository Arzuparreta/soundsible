# Install & Deployment

This guide covers running Soundsible **beyond the basic local setup** in the [README](../README.md) — on a server, kept running in the background, or exposed across your network.

> **Just want to run it on your own machine?** Follow [Install in the README](../README.md#install). This page is for self-hosting (server, NAS, Tailscale, reverse proxy, systemd).

The supported entry point everywhere is `python3 run.py`. It creates the project virtualenv, repairs a broken one, installs requirements, and then starts the launcher / engine. Server and SSH workflows use the legacy daemon on a fixed port (`:5005`); the desktop appliance runtime (`--desktop-engine`) binds loopback on a random port and is covered in the [README](../README.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## 1. Requirements

- **Python 3.10+** and **git**
- **FFmpeg** — not bundled; install via your OS package manager:
  - Debian/Ubuntu: `sudo apt install ffmpeg`
  - Arch: `sudo pacman -S ffmpeg`
  - Fedora: `sudo dnf install ffmpeg`
  - macOS: `brew install ffmpeg`
  - Windows: `winget install Gyan.FFmpeg` or the [FFmpeg download page](https://ffmpeg.org/download.html)

Optional: a modern browser for the Station UI, Tailscale for remote access, and a NAS or object-storage backend (R2/B2/S3) for large libraries.

---

## 2. Headless server (SSH)

Same as a local install, run over SSH:

```bash
sudo apt update
sudo apt install -y python3-venv python3-pip ffmpeg git
git clone https://github.com/Arzuparreta/soundsible.git
cd soundsible
python3 run.py          # first run opens setup; then choose "Start Station Engine"
```

Access the player from another machine on the network:

```text
http://SERVER_LAN_IP:5005/player/
```

To keep it running after you disconnect, use a process manager — `systemd`, `supervisord`, or a multiplexer like `tmux` / `screen` — configured to your usual standards. The server path assumes the legacy daemon:

```bash
python3 run.py --daemon   # fixed port 5005, reachable on the LAN
```

---

## 3. Remote access over Tailscale

[Tailscale](https://tailscale.com/) gives you secure remote access without port forwarding or VPN config.

1. Install and log into Tailscale on the machine running Soundsible.
2. Start the Station Engine.
3. From any device on your tailnet, open `http://YOUR_TAILSCALE_IP:5005/player/`.
4. Optionally install the web player as a PWA (see the [README](../README.md#listen-everywhere)).

---

## 4. Reverse proxy (optional)

Serve Soundsible behind Nginx, Caddy, or Traefik:

1. Run the Station Engine on its default port (`5005`).
2. Forward a public path (e.g. `https://music.example.com`) to `http://127.0.0.1:5005`.
3. Allow WebSocket / long-running connections in your proxy config.

Reverse-proxy the **legacy daemon** port, not the desktop-sidecar's random loopback port. See your proxy's docs for TLS and exact snippets.

---

## 5. Storage

By default Soundsible uses local disk on the host. For larger or shared libraries:

- **NAS / shared storage** — mount an NFS or SMB path and point the setup wizard at it.
- **Object storage** — configure Cloudflare R2, Backblaze B2, or generic S3 in the setup wizard.

See [CONFIGURATION.md](./CONFIGURATION.md) for storage options.

---

## 6. Security baseline

Soundsible is designed for trusted **LAN / Tailscale** use. For anything beyond a single machine:

1. **Don't expose it publicly.** Never port-forward Station (`5005`) or Launcher (`5099`) to the internet — use Tailscale for remote access.

2. **Protect admin routes with a token:**

   ```bash
   export SOUNDSIBLE_ADMIN_TOKEN='your-long-random-token'
   ```

   Send it as `Authorization: Bearer <token>` or `X-Soundsible-Admin-Token: <token>`. In desktop-engine mode, Soundsible also creates a short-lived owner token and injects it into `/player/desktop/` automatically.

3. **Launcher binding.** The launcher binds to localhost by default. To allow LAN access intentionally:

   ```bash
   export SOUNDSIBLE_LAUNCHER_BIND_ALL=true
   ```

4. **CORS origins.** By default the API accepts localhost, private-LAN, and Tailscale browser origins. To tighten:

   ```bash
   export SOUNDSIBLE_ALLOWED_ORIGINS='http://localhost:5005,http://192.168.1.10:5005'
   export SOUNDSIBLE_SOCKET_CORS_ORIGINS='http://localhost:5005,http://192.168.1.10:5005'
   ```

---

For environment variables, downloader tuning, and YouTube cookies, see [CONFIGURATION.md](./CONFIGURATION.md).
