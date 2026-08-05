# Install & Deployment

This guide covers running Soundsible **beyond the basic local setup** in the [README](../README.md) — on a server, kept running in the background, or exposed across your network.

> **Just want to run it on your own machine?** Follow [Install in the README](../README.md#install). For a containerized server, use the [Docker deployment](DOCKER.md). This page covers manual self-hosting (server, NAS, Tailscale, reverse proxy, systemd).

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
3. Allow your user to manage Tailscale Serve once, then publish the engine:

   ```bash
   sudo tailscale set --operator="$USER"
   tailscale serve --bg --yes --https=443 5005
   ```

4. From any device on your tailnet, open the HTTPS URL printed by `tailscale
   serve status`, followed by `/player/`. HTTPS is required for Live
   broadcasting in browsers — see [Live](LIVE.md#5-broadcasting-needs-https).
5. If the `.ts.net` name does not resolve on a client, enable Tailscale DNS
   there with `sudo tailscale set --accept-dns=true`.
6. Optionally install the web player as a PWA (see the [README](../README.md#listen-everywhere)).

### Sharing the node with other services

Tailscale's `serve` and `funnel` state belongs to the **machine**, not to
Soundsible. Each HTTPS port routes `/` to exactly one backend, and only ports
`443`, `8443` and `10000` are available. Whatever configures a port last wins,
silently — nothing warns the service it displaced.

That is why step 3 spells out `--https=443` instead of relying on the default:
the port is a choice, and on a machine that already publishes something else you
should make it a different one.

```bash
tailscale serve --bg --yes --https=8443 5005   # Soundsible alongside another service
```

Soundsible never writes this configuration for you. It reads your Tailscale
address when it needs it, but publishing the station stays a deliberate act, so
installing it can never take a port another project is already serving.

### The station is up but the `.ts.net` URL returns 502

A `502 Bad Gateway` means Tailscale accepted the request and found nothing
listening behind the port. The Station Engine is usually fine — check where the
node is actually pointing before looking at Soundsible at all:

```bash
tailscale serve status                       # which backend owns each port?
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5005/   # 200 = engine is healthy
```

If `serve status` shows a port aimed somewhere other than `5005`, another
service claimed it — commonly one installed as a systemd unit that reclaims the
port on every boot, which is why this tends to appear right after a reboot
rather than when you install it. Re-run step 3 to take the port back, and give
the other service a port of its own so the two stop trading it.

To make your own choice survive reboots, install it as a unit instead of leaving
it to a command you ran once:

```ini
# ~/.config/systemd/user/tailscale-funnel-soundsible.service
[Unit]
Description=Tailscale Funnel for Soundsible Station Engine
After=tailscaled.service

[Service]
Type=oneshot
ExecStart=/usr/bin/tailscale funnel --bg --https=443 5005
RemainAfterExit=yes
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now tailscale-funnel-soundsible.service
```

---

## 4. Reverse proxy (optional)

Serve Soundsible behind Nginx, Caddy, or Traefik:

1. Run the Station Engine on its default port (`5005`).
2. Forward a public path (e.g. `https://music.example.com`) to `http://127.0.0.1:5005`.
3. Allow WebSocket / long-running connections in your proxy config.

Reverse-proxy the **legacy daemon** port, not the desktop-sidecar's random loopback port. See your proxy's docs for TLS and exact snippets.

---

## 5. VPS with residential YouTube relay

If YouTube classifies the VPS address as automated traffic, Soundsible can use
an official Tailscale-only relay on a trusted Linux PC. This preserves a VPS
Station while keeping URL resolution and media transfer on the same residential
egress.

Follow [Verified VPS relay](VPS_RELAY.md). Do not substitute an internet-facing
open proxy.

---

## 6. Storage

By default Soundsible uses local disk on the host. For larger or shared libraries:

- **NAS / shared storage** — mount an NFS or SMB path and point the setup wizard at it.
- **Object storage** — configure Cloudflare R2, Backblaze B2, or generic S3 in the setup wizard.

See [CONFIGURATION.md](./CONFIGURATION.md) for storage options.

---

## 7. Security baseline

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
