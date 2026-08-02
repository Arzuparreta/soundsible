# Docker deployment

Soundsible ships a multi-stage production image and a Compose stack. The image
contains FFmpeg, Chromaprint, Python dependencies, and the compiled SolidJS
player; Node.js and build tools do not remain in the runtime image.

## Quick start

```bash
git clone https://github.com/Arzuparreta/soundsible.git
cd soundsible
docker compose up -d --build
docker compose ps
```

When the service reports `healthy`, open <http://localhost:5005/player/>.
The first boot creates a local provider configuration for `/music`. Later boots
reuse `/config/config.json` and never replace it.

The default stack uses five named volumes. With the default Compose project
name, Docker stores them as `soundsible_soundsible-*`:

| Volume | Container path | Contents |
| --- | --- | --- |
| `soundsible_soundsible-config` | `/config` | Instance configuration, accounts, and user libraries |
| `soundsible_soundsible-data` | `/data` | Persistent queues, instance database, and telemetry |
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
not.

## Configuration and security

Compose reads optional values from a `.env` file beside `compose.yaml`:

```dotenv
SOUNDSIBLE_PORT=5005
SOUNDSIBLE_ADMIN_TOKEN=replace-with-a-long-random-value
SOUNDSIBLE_YT_SEARCH_SOURCE=ytmusic
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

The Docker path is continuously built and started in GitHub Actions for every
pull request and change to `main` or `dev`. A scheduled clean rebuild also
checks it against freshly pulled base images and package indexes. A green
`docker` check means the actual Compose deployment started healthy, served the
player, ran as its unprivileged user, and kept first-run configuration across a
container recreation.

View status and logs:

```bash
docker compose ps
docker compose logs -f soundsible
curl --fail http://localhost:5005/api/health
```

Upgrade the checkout and recreate the service without touching volumes:

```bash
git pull --ff-only
docker compose build --pull
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

Back up the music volume separately when it contains the only copy of your
audio. The cache and logs volumes are optional in backups.

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
