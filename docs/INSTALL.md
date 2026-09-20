# Install & Deployment

Run Soundsible on your computer or a server, then listen in your browser.
For containers, use the [Docker guide](DOCKER.md). For a bundled app, see
[Desktop beta](DESKTOP_BETA.md).

## Ways to run it

A source install has one entry point, `run.py`. Every start prepares the
project virtualenv and installs any changed Python requirements, then runs
Soundsible in one of three ways:

| Command | What runs | Use it when |
| --- | --- | --- |
| `python3 run.py` | A terminal menu that starts, opens and stops the engine for you. | You are trying Soundsible on the computer in front of you. Quitting the menu stops the engine. |
| `python3 run.py --daemon` | The engine on its own, in the foreground, logging to the terminal. `Ctrl+C` stops it. | You run a server, a `tmux` session, or anything else that supervises processes. |
| [A systemd service](#run-it-as-a-systemd-service) | `run.py --daemon` under systemd: starts at boot, restarts after a crash, logs to the journal. | You want Soundsible always on, on Linux. |

All three serve the player at `http://<machine>:5005/player/` and share the
same configuration, library and accounts, so you can start with the menu and
move to the service later. Whichever you use first needs the
[first-run setup](#first-run), once.

---

## 1. Requirements

- **Python 3.10+**, **git**, and **Node.js 22+** with **npm**
  (the web player is built from source during engine startup).
- **FFmpeg** — not bundled; install via your OS package manager:
  - Debian/Ubuntu: `sudo apt install ffmpeg`
  - Arch: `sudo pacman -S ffmpeg`
  - Fedora: `sudo dnf install ffmpeg`
  - macOS: `brew install ffmpeg`
  - Windows: `winget install Gyan.FFmpeg` or the [FFmpeg download page](https://ffmpeg.org/download.html)

Optional: Tailscale for remote access, and a NAS or object storage
(Cloudflare R2 or Backblaze B2) for large libraries.

---

## 2. Install on your computer

<details>
<summary><b>🐧 &nbsp; Linux</b></summary>
<br>

```bash
# 1. Install prerequisites (Debian / Ubuntu)
sudo apt install -y git ffmpeg python3 python3-venv python3-pip nodejs npm

# 2. Get Soundsible
git clone https://github.com/Arzuparreta/soundsible.git
cd soundsible

# 3. Install web player deps (one-time; dist builds on engine start)
cd ui_web && npm ci && cd ..

# 4. Run it
python3 run.py
```

Check `node --version`: you need Node.js 22 or newer. If your distribution
ships an older version, install a current Node.js release before `npm ci`.

**Other distros** — swap step 1:

- **Arch:** `sudo pacman -S git ffmpeg python python-pip nodejs npm`
- **Fedora:** `sudo dnf install git ffmpeg python3 python3-pip nodejs npm`

</details>

<details>
<summary><b>🍎 &nbsp; macOS</b></summary>
<br>

Requires [Homebrew](https://brew.sh).

```bash
# 1. Install prerequisites
brew install git ffmpeg python node

# 2. Get Soundsible
git clone https://github.com/Arzuparreta/soundsible.git
cd soundsible

# 3. Install web player deps (one-time; dist builds on engine start)
cd ui_web && npm ci && cd ..

# 4. Run it
python3 run.py
```

</details>

<details>
<summary><b>🪟 &nbsp; Windows</b></summary>
<br>

In **PowerShell**:

```powershell
# 1. Install prerequisites
winget install Git.Git Python.Python.3.12 Gyan.FFmpeg OpenJS.NodeJS.LTS

# 2. Close and reopen PowerShell so the new tools are on PATH, then:
git clone https://github.com/Arzuparreta/soundsible.git
cd soundsible

# 3. Install web player deps (one-time; dist builds on engine start)
cd ui_web; npm ci; cd ..

# 4. Run it
python run.py
```

No `winget`? Install [Git](https://git-scm.com/download/win), [Python](https://www.python.org/downloads/) (tick *"Add to PATH"*), [Node.js](https://nodejs.org/) (LTS), and [FFmpeg](https://ffmpeg.org/download.html) manually.

On Windows, type `python` wherever this guide says `python3`.

</details>

### First run

The first `python3 run.py` creates the project virtualenv, installs Python
dependencies and, because nothing is configured yet, starts the **setup page**
instead of the menu. Open **<http://localhost:5099/setup>**, choose where your
music lives and save. Go back to the launcher page and click **Launch** to
start the engine, then open **<http://localhost:5005/player/>**. Keep the
terminal open while you listen.

To reopen setup later, run `python3 run.py --setup`.

### Every run after that

`python3 run.py` opens the terminal menu:

| Key | Does |
| --- | --- |
| `1` | Start the engine and open the player in your browser |
| `2` | Start the engine without opening a browser |
| `3` | Open the player (the engine must already be running) |
| `4` | Stop the engine |
| `5` | Search your library from the terminal |
| `6` | Open the setup page again |
| `q` | Quit — this also stops the engine |

The menu is for a session at your computer: keep its terminal open while you
listen.

You do not need the menu. To run the engine without it — on a server, in
`tmux`, or under systemd — use `--daemon`:

```bash
python3 run.py --daemon   # Ctrl+C stops it
```

[Running on a server](INSTALL.md#3-headless-server-ssh) covers that mode and
the systemd service. Prefer a browser panel to the terminal? Run
`./venv/bin/python start_launcher.py` (on Windows,
`.\venv\Scripts\python start_launcher.py`), open **<http://localhost:5099>**
and click **Launch**.

---

## 3. Headless server (SSH)

Over SSH, follow steps 1–3 of the Linux install in
[section 2](#2-install-on-your-computer). Then configure Soundsible once, and
run the engine with `--daemon`, either directly or as a service.

### First-time setup without a desktop

The setup page only listens on the server's own `localhost`. Forward it to
the computer you are sitting at:

```bash
# On your computer: open an SSH session that forwards port 5099
ssh -L 5099:localhost:5099 you@SERVER

# In that session, from the soundsible checkout on the server
python3 run.py --setup
```

Open **<http://localhost:5099/setup>** in your own browser, choose where the
music lives on the server, and save. Ignore **Launch** — stop the setup page
with `Ctrl+C` and start the engine as below.

To reach the setup page over the LAN instead, bind it to the network on
purpose for this one run and open `http://SERVER_LAN_IP:5099/setup`:

```bash
SOUNDSIBLE_LAUNCHER_BIND_ALL=true python3 run.py --setup
```

### Run the engine with `--daemon`

```bash
python3 run.py --daemon
```

This is the server mode: no menu, the engine in the foreground, its log on
the terminal and `Ctrl+C` to stop it. It listens on every interface at port
`5005`, so any device on the network can open:

```text
http://SERVER_LAN_IP:5005/player/
```

Change the address with `--host` and `--port` (or `SOUNDSIBLE_HOST` and
`SOUNDSIBLE_PORT`); `--host 127.0.0.1` keeps it to the machine itself, for
example behind a [reverse proxy](#5-reverse-proxy-optional). Without a
configuration it refuses to start and tells you to run `--setup` first.

`--daemon` stops with its terminal. Run it inside `tmux` or `screen` to keep a
manual session alive after you disconnect, or let systemd run it.

### Run it as a systemd service

On Linux, a systemd service starts Soundsible at boot, restarts it if it
crashes, and keeps its log in the journal. Run these commands from the
soundsible checkout, as the user who completed setup — not from a root shell.
The unit is written with that user and that folder filled in:

```bash
sudo tee /etc/systemd/system/soundsible.service > /dev/null <<EOF
[Unit]
Description=Soundsible Station Engine
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$PWD
Environment=PYTHONUNBUFFERED=1
ExecStart=$PWD/venv/bin/python $PWD/run.py --daemon
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now soundsible
```

Running it as your own user matters: Soundsible keeps its configuration,
accounts and library database under that user's home directory, so the
service picks up exactly what setup wrote. To see what was written, run
`cat /etc/systemd/system/soundsible.service`.

Day-to-day:

```bash
systemctl status soundsible          # is it running?
journalctl -u soundsible -f          # follow the log
sudo systemctl restart soundsible    # after an update or a config change
sudo systemctl stop soundsible       # stop it until the next boot
sudo systemctl disable --now soundsible   # stop it and stop starting at boot
```

Settings that come from the environment — the admin token, a YouTube relay,
anything in [Configuration](CONFIGURATION.md#2-environment-variables) — go in
a drop-in rather than in your shell, since the service never reads your shell
profile:

```bash
sudo systemctl edit soundsible
```

```ini
[Service]
Environment=SOUNDSIBLE_ADMIN_TOKEN=your-long-random-token
```

Save, then `sudo systemctl restart soundsible`.

Two things to know once systemd owns the engine:

- **Manage it with `systemctl`, not the menu.** Menu option `4`, and quitting
  the menu, kill whatever is listening on port 5005 — the service included.
- **The service does not see your shell's `PATH`.** The engine rebuilds the
  web player with `npm` after an update. If Node.js came from `nvm`, `fnm` or
  another per-user installer, add its directory to the drop-in, for example
  `Environment=PATH=/home/you/.nvm/versions/node/<version>/bin:/usr/local/bin:/usr/bin:/bin`.

systemd is Linux only. On other systems, [Docker](DOCKER.md) with its
`restart: unless-stopped` policy is the way to keep Soundsible running across
reboots.

### Other `run.py` commands

| Command | Does |
| --- | --- |
| `python3 run.py --setup` | Opens only the setup page on port 5099. |
| `python3 run.py --users list` | Manages accounts without a browser; `--users -h` lists every command. See [Accounts](CONFIGURATION.md#6-accounts-multi-user). |
| `python3 run.py --relay …` | Installs or checks the residential YouTube relay. See [VPS relay](VPS_RELAY.md). |
| `python3 run.py --help` | Lists every option, including `--host`, `--port` and the directory overrides. |

`--desktop-engine` exists for the [desktop app](DESKTOP_BETA.md), which starts
its own engine on a random local port; you do not run it by hand.

---

## 4. Remote access over Tailscale

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
6. Optionally add the player to your home screen: **Share → Add to Home Screen**
   on iOS, or **Menu → Install app** on Android.

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
# /etc/systemd/system/tailscale-serve-soundsible.service
[Unit]
Description=Publish Soundsible on the tailnet
Wants=tailscaled.service
After=tailscaled.service

[Service]
Type=oneshot
ExecStart=/usr/bin/tailscale serve --bg --yes --https=443 5005
RemainAfterExit=yes
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tailscale-serve-soundsible.service
```

This publishes the station to your tailnet only, like step 3. `tailscale
funnel` would publish it to the whole internet; read the
[security baseline](#8-security-baseline) before choosing that.

---

## 5. Reverse proxy (optional)

Serve Soundsible behind Nginx, Caddy, or Traefik:

1. Run the Station Engine with `--daemon` on its default port (`5005`), or
   with `--host 127.0.0.1` so only the proxy can reach it.
2. Forward a public path (e.g. `https://music.example.com`) to `http://127.0.0.1:5005`.
3. Allow WebSocket / long-running connections in your proxy config.

Proxy the server port, not the desktop app's engine, which listens on a random
local port. See your proxy's docs for TLS and exact snippets.

---

## 6. VPS with residential YouTube relay

If YouTube classifies the VPS address as automated traffic, Soundsible can use
an official Tailscale-only relay on a trusted Linux PC. This preserves a VPS
Station while keeping URL resolution and media transfer on the same residential
egress.

Follow [Verified VPS relay](VPS_RELAY.md). Do not substitute an internet-facing
open proxy.

---

## 7. Storage

By default Soundsible uses local disk on the host. For larger or shared libraries:

- **NAS / shared storage** — mount an NFS or SMB path and point the setup wizard at it.
- **Object storage** — configure Cloudflare R2 or Backblaze B2 in the setup wizard.

If the library lives on a network mount and Soundsible runs as a
[service](#run-it-as-a-systemd-service), make the service wait for the mount
with a drop-in (`sudo systemctl edit soundsible`):

```ini
[Unit]
RequiresMountsFor=/mnt/music
```

See [CONFIGURATION.md](./CONFIGURATION.md) for storage options.

---

## 8. Security baseline

Soundsible is designed for trusted **LAN / Tailscale** use. For anything beyond a single machine:

1. **Don't expose it publicly.** Never port-forward Station (`5005`) or Launcher (`5099`) to the internet — use Tailscale for remote access.

2. **Protect admin routes with a token.** Generate one with
   `openssl rand -hex 32` and give it to the engine — in the service's
   drop-in (see [above](#run-it-as-a-systemd-service)), or exported in the
   shell that starts it:

   ```bash
   export SOUNDSIBLE_ADMIN_TOKEN='your-long-random-token'
   ```

   Send it as `Authorization: Bearer <token>` or `X-Soundsible-Admin-Token: <token>`. In desktop-engine mode, Soundsible also creates a short-lived owner token and injects it into `/player/desktop/` automatically.

3. **Add a password once other people use it.** A single-account install has
   no login screen. Adding a second person turns sign-in on for everyone — see
   [Accounts](CONFIGURATION.md#6-accounts-multi-user).

4. **Launcher binding.** The launcher binds to localhost by default. To allow LAN access intentionally:

   ```bash
   export SOUNDSIBLE_LAUNCHER_BIND_ALL=true
   ```

5. **CORS origins.** By default the API accepts localhost, private-LAN, and Tailscale browser origins. To tighten:

   ```bash
   export SOUNDSIBLE_ALLOWED_ORIGINS='http://localhost:5005,http://192.168.1.10:5005'
   export SOUNDSIBLE_SOCKET_CORS_ORIGINS='http://localhost:5005,http://192.168.1.10:5005'
   ```

---

## 9. Updating

From the soundsible checkout:

```bash
git pull
cd ui_web && npm ci && cd ..
```

Then restart Soundsible the way you run it: quit and reopen the menu, stop and
rerun `--daemon`, or `sudo systemctl restart soundsible`. On start, `run.py`
installs any changed Python requirements and rebuilds the web player, so there
is no separate build step.

`git pull` follows `main`, the same code as the `edge` container image. If you
cloned a release tag instead — the website's quick commands do — move to a
newer [release](https://github.com/Arzuparreta/soundsible/releases) with
`git fetch --tags` followed by `git checkout` and the new tag.

Docker updates are covered in [Docker → Operations](DOCKER.md#operations).

---

For environment variables, downloader tuning, and YouTube cookies, see [CONFIGURATION.md](./CONFIGURATION.md).
