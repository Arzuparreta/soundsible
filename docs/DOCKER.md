# Docker deployment

Soundsible ships a multi-stage production image and a Compose stack. The image
contains FFmpeg, Python dependencies, the compiled SolidJS player and the Auto
DJ beat model (84 MB, verified against its SHA-256 at build time); Node.js and
build tools do not remain in the runtime image.

Images are published to the GitHub Container Registry for `linux/amd64` and
`linux/arm64`, so a NAS, a Raspberry Pi, or an Apple Silicon Mac runs the same
image as an x86 server without compiling anything.

| Tag | What it is |
| --- | --- |
| `ghcr.io/arzuparreta/soundsible:edge` | Every commit that lands on `main`. Current default. |
| `ghcr.io/arzuparreta/soundsible:latest` | The most recent tagged release. |
| `ghcr.io/arzuparreta/soundsible:X.Y.Z` · `:X.Y` | A specific release, pinned. |

GitHub Actions signs the image's digest after publishing it. Verify the tag or
digest you intend to deploy with GitHub CLI.

```bash
gh attestation verify oci://ghcr.io/arzuparreta/soundsible:edge --repo Arzuparreta/soundsible
```

A tag can be available before its signing job succeeds. If verification reports
no attestation, check the `attest_image` job in the corresponding CI run and
retry once it succeeds.

## Quick start

No checkout, no build toolchain:

```bash
curl -O https://raw.githubusercontent.com/Arzuparreta/soundsible/main/compose.yaml
docker compose up -d
docker compose ps
```

Or without Compose at all:

```bash
docker run -d --name soundsible \
  -p 5005:5005 \
  -v soundsible-config:/config \
  -v soundsible-data:/data \
  -v soundsible-cache:/cache \
  -v soundsible-logs:/logs \
  -v soundsible-music:/music \
  ghcr.io/arzuparreta/soundsible:edge
```

Pin a release instead of tracking `main` by setting `SOUNDSIBLE_TAG` in a `.env`
file beside `compose.yaml`, or by naming the tag directly in `docker run`.

When the service reports `healthy`, open <http://localhost:5005/player/>.
The first boot creates a local provider configuration for `/music`. Later boots
reuse `/config/config.json` and never replace it.

The default stack uses five named volumes. With the default Compose project
name, Docker stores them as `soundsible_soundsible-*`:

| Volume | Container path | Contents |
| --- | --- | --- |
| `soundsible_soundsible-config` | `/config` | Instance configuration and database: accounts, and each person's library and playlists |
| `soundsible_soundsible-data` | `/data` | Queues, import jobs, listening telemetry, and preserved artwork |
| `soundsible_soundsible-cache` | `/cache` | Rebuildable covers, previews, and media cache |
| `soundsible_soundsible-logs` | `/logs` | Runtime logs |
| `soundsible_soundsible-music` | `/music` | Imported and downloaded audio |

`docker compose down` keeps all five volumes. Do not use `down --volumes` unless
you intentionally want to delete the complete Docker-managed instance.

## Use an existing host library

Replace the music volume in `compose.yaml` with an absolute bind mount:

```yaml
services:
  soundsible:
    volumes:
      - /srv/music:/music
```

Soundsible runs as UID/GID `1000:1000`. The mounted directory must be readable
and writable by that identity if you want Soundsible to save downloads:

```bash
sudo chown -R 1000:1000 /srv/music
```

If the directory must remain read-only, mount it as `/music:ro`; playback and
scanning work, but downloads and library modifications that write audio will
not. Open **Settings → Library → Rescan files** after mounting it. Soundsible
indexes supported files in place; it does not copy or rename the originals.

## Migrate a native installation

Use the published image and Compose file from [Quick start](#quick-start).
Save the file in a new directory and wait to start Compose until you have
seeded the configuration and data volumes. Use fresh volumes. If there is
already a Docker installation on the host, give the migration a distinct
project name and use it for each Compose command.

1. In the Compose file, [bind your existing music folder](#use-an-existing-host-library)
   and set `SOUNDSIBLE_CONTAINER_AUTO_CONFIGURE: "false"` under the service's
   `environment`. Keep the same published host port if clients or a reverse
   proxy already use it. Carry over any environment settings your native service
   relies on, such as an admin token or download proxy. Pull the image with
   `docker compose pull` before stopping the native engine.
2. Stop the native engine and any separate downloader or sync jobs. For a
   native installation using the systemd unit from the install guide, run
   `sudo systemctl stop soundsible.service`. Keep the original configuration and
   data directories, and back up the music folder separately if it holds your
   only copy of the audio.
3. From the native Soundsible checkout, with its Python environment active,
   create a verified backup and a separate copy to prepare for the container.
   The example uses the [default Linux paths](CONFIGURATION.md#7-where-soundsible-keeps-its-files).
   Substitute your actual configuration and data directories if you set overrides.

   ```bash
   migration_dir=$(mktemp -d "$HOME/soundsible-migration.XXXXXX")
   python -m shared.instance_backup create "$migration_dir/backup" \
     --config-dir "$HOME/.config/soundsible" \
     --data-dir "$HOME/.local/share/soundsible" --stopped
   python -m shared.instance_backup verify "$migration_dir/backup"
   python -m shared.instance_backup restore "$migration_dir/backup" "$migration_dir/restore"
   ```

4. Review paths in the restored copy under `restore/config`. With the usual
   `/music` mount, update the local provider's filesystem `endpoint` in
   `config.json` to `/music` and map `watch_folders` to the paths you mounted.
   Update `music_dir.json` (`path`), `output_dir` and `downloader.env`
   (`OUTPUT_DIR`), where present, to match. Check any other settings that point
   to host files, such as a custom cookies path.

   Scanned tracks already in your library can have absolute paths in SQLite.
   Mount their folders at the original absolute paths inside the container and
   keep those paths in the watch folders. If the scanned tracks are under the
   main music folder, bind that folder at its original path as well and set
   both `SOUNDSIBLE_MUSIC_DIR` and `OUTPUT_DIR` in the service environment to
   that path. Keep the original music paths in the restored settings in that
   case. This preserves the paths SQLite already has.
5. From the Compose directory, load the restored copy into the volumes, then
   start the service. The import runs under the same user as Soundsible.

   ```bash
   set -o pipefail
   tar -C "$migration_dir/restore" -cf - config data |
     docker compose run --rm --no-deps -T --entrypoint tar soundsible -C / -xf - &&
     docker compose up -d --wait
   ```

6. Sign in at the same URL and check your library, playlists and local audio
   playback. If the native engine was configured to start on boot, disable its
   autostart after the Docker checks pass. For systemd, run
   `sudo systemctl disable soundsible.service`. Keep the backup until you have
   tested the migration. To switch back, stop Compose with `docker compose stop
   soundsible`, then start the native engine from its original configuration
   and data. Re-enable native autostart if you disabled it. Changes made in
   Docker after the switch are stored in the Docker volumes.

## Remote access over Tailscale

Run Tailscale on the Docker host. After `docker compose ps` shows a healthy
service, check the published port from the host. With the default settings,
`curl --fail http://127.0.0.1:5005/api/health` returns `healthy`. Point
Tailscale Serve at that host port using the [native guide's Tailscale steps](INSTALL.md#4-remote-access-over-tailscale).
If you set `SOUNDSIBLE_PORT` in the Compose `.env`, use that port in both the
health check from the host and the Tailscale command.

An existing Serve or Funnel route continues to work when Docker publishes
the same port on the same host. Check `tailscale serve status` for the target
and open `/player/` on your existing HTTPS URL. For access exclusively through
the host's Tailscale proxy, you can bind the published port to loopback in
`compose.yaml` with `"127.0.0.1:${SOUNDSIBLE_PORT:-5005}:5005"`.

## Configuration and security

Compose reads optional values from a `.env` file beside `compose.yaml`:

```dotenv
SOUNDSIBLE_TAG=edge
SOUNDSIBLE_PORT=5005
SOUNDSIBLE_ADMIN_TOKEN=replace-with-a-long-random-value
SOUNDSIBLE_YT_SEARCH_SOURCE=youtube
SOUNDSIBLE_PREVIEW_CACHE_MB=2048
SOUNDSIBLE_COMMUNITY_DISABLED=false
```

Generate an admin token with `openssl rand -hex 32`. Soundsible is designed for
a trusted LAN or Tailscale network; do not expose port 5005 directly to the
public internet. Put a TLS reverse proxy or Tailscale in front of it when remote
access is required.

To supply an existing configuration instead of the automatic local one, mount
it under `/config` and set:

```yaml
environment:
  SOUNDSIBLE_CONTAINER_AUTO_CONFIGURE: "false"
```

All runtime environment variables documented in [Configuration](CONFIGURATION.md)
can be added to the Compose `environment` section. Paths inside the container
must use the container paths (`/config`, `/data`, `/cache`, `/logs`, `/music`).

## Operations

GitHub Actions builds and starts the Docker stack when image inputs change.
A scheduled clean rebuild also checks freshly pulled base images and package
indexes. The `docker` smoke test checks that Compose starts healthy, serves the
player, runs Soundsible as an unprivileged user, and keeps first-run
configuration across a container recreation. A failing Docker check blocks
publication. When the image inputs are unchanged, CI can skip those checks and
still publish an image for the new commit.

View status and logs:

```bash
docker compose ps
docker compose logs -f soundsible
curl --fail http://localhost:5005/api/health
```

Upgrade to a newer image and recreate the service without touching volumes:

```bash
docker compose pull
docker compose up -d
```

`docker compose up -d` replaces the container when the image changes and keeps
all five named volumes. Do not use automatic image-updaters: review and apply
Soundsible releases deliberately, so an upstream change cannot silently alter
your running music server.

### Maintainer dependency updates

The production image installs from the hash-checked
`requirements.docker.lock`, generated for its Python 3.13 runtime. It prevents
the same commit from resolving to a different Python dependency set tomorrow.
When changing `requirements.txt` or deliberately refreshing dependencies,
regenerate it and commit both files:

```bash
python3 -m pip install 'pip-tools==7.5.3'
pip-compile --upgrade --generate-hashes --strip-extras \
  --output-file requirements.docker.lock requirements.txt
```

CI rejects a Docker lock that does not satisfy a direct requirement. The daily
clean Docker rebuild remains responsible for base-image and Debian package
changes.

Back up persistent state while the service is stopped:

```bash
docker compose stop soundsible
docker run --rm \
  -v soundsible_soundsible-config:/source:ro \
  -v "$PWD":/backup \
  alpine tar czf /backup/soundsible-config-backup.tgz -C /source .
docker run --rm \
  -v soundsible_soundsible-data:/source:ro \
  -v "$PWD":/backup \
  alpine tar czf /backup/soundsible-data-backup.tgz -C /source .
docker compose start soundsible
```

For checksummed copies, SQLite validation and restoration into a fresh directory,
see [verified offline recovery](internal/engineering/instance-recovery.md). That procedure
also carries the key for encrypted storage credentials to a replacement container.

Back up the music volume separately when it contains the only copy of your
audio. The cache and logs volumes are optional in backups.

## Build from source instead

`compose.yaml` deliberately has no `build:` section, so it can never quietly
compile on hardware that cannot afford it. Stack `compose.build.yaml` on top
when you want the image built from your working tree:

```bash
git clone https://github.com/Arzuparreta/soundsible.git
cd soundsible
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

Set it once for the shell instead of repeating both `-f` flags:

```bash
export COMPOSE_FILE=compose.yaml:compose.build.yaml
```

This is what CI does, so the pull-request smoke test exercises the commit under
review rather than the last published image.

## Build the image directly

```bash
docker build \
  --build-arg SOUNDSIBLE_VERSION=dev \
  --build-arg VCS_REF="$(git rev-parse --short HEAD)" \
  -t soundsible:dev .
docker run --rm -p 5005:5005 \
  -v soundsible-config:/config \
  -v soundsible-data:/data \
  -v soundsible-cache:/cache \
  -v soundsible-logs:/logs \
  -v soundsible-music:/music \
  soundsible:dev
```
