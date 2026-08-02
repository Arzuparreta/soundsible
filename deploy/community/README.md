# Soundsible Community live stack

This stack relays live programme audio from a Soundsible Station to listeners.
It deliberately does not record audio, reconstruct tracks, ingest microphones,
store chat history, or implement song requests. Chat is a transient plain-text
room; a listener can type a request like any other message.

## Components and bounds

- `community-api`: signed DJ sessions, directory, synchronized programme
  metadata, presence, ephemeral cover cache and Socket.IO chat.
- `mediamtx`: one Opus WHIP publisher and WHEP readers per active session.
- `coturn`: STUN discovery plus authenticated TURN fallbacks on TLS/TCP 443,
  UDP 443 and TCP 3478 for browsers behind restrictive networks.
- Nginx: TLS and the single public origin.
- Defaults: 5 concurrent sessions, 100 listeners per session, 250 listeners
  total, 90 seconds for the DJ to reconnect, and 30 minutes before a room that
  never played a note releases its slot (`COMMUNITY_IDLE_SESSION_SECONDS`). A
  DJ on a break keeps reporting the programme, so a break never counts as idle.

The service keeps no replay. Closing a session removes its database lease and
uploaded artwork; chat messages are only emitted to clients currently in the
room.

## Host deployment

Copy `community_service/` and `deploy/community/` to a host with Docker Compose.
Create `deploy/community/.env` from `.env.example`, replace
`COMMUNITY_SECRET_KEY` and `COMMUNITY_TURN_SECRET` with separate long random
values, install `nginx-bootstrap.conf`, obtain the matching TLS certificate,
and replace it with `nginx.conf`. The official single-IP host also installs
`libnginx-mod-stream`, includes `stream { include
/etc/nginx/streams-enabled/*.conf; }` at Nginx's top level, installs
`nginx-turn-stream.conf`, and moves its IPv4 HTTPS virtual hosts to
`127.0.0.1:8443`. The stream router then sends the TURN hostname to Coturn and
all other SNI names back to HTTPS. Adapt the hostname and public IP in both
files for another deployment. Then run:

```bash
docker compose --env-file deploy/community/.env \
  -f deploy/community/docker-compose.yml up -d --build
```

Before starting and after each TURN certificate renewal, place container-readable
copies inside a root-protected directory:

```bash
install -d -m 700 deploy/community/certs
install -m 644 /etc/letsencrypt/live/turn.example.org/fullchain.pem deploy/community/certs/turn.crt
install -m 644 /etc/letsencrypt/live/turn.example.org/privkey.pem deploy/community/certs/turn.key
docker compose --env-file deploy/community/.env \
  -f deploy/community/docker-compose.yml restart coturn-tls
```

Expose TCP 80/443/3478, UDP 443/3478, UDP and TCP 8189, and UDP 49152–50687.
TLS/TCP 443 is the primary TURN path because it survives networks that block
3478 and non-HTTPS traffic; UDP 443 and TCP 3478 remain fallbacks. The bounded
UDP range is used only for authenticated relay allocations. Ports 18080, 18889
and TURN TLS 5349 intentionally bind only to loopback behind Nginx.

Health and capacity can be checked with:

```bash
curl -fsS https://live.84-247-161-82.sslip.io/health
docker compose --env-file deploy/community/.env \
  -f deploy/community/docker-compose.yml ps
```

## Connect a Station

No Station configuration is required for the official Soundsible service.
Opening **Live** connects to it on demand; ordinary startup makes no external
Community request unless the Station has an active broadcast to resume.

Operators can set `SOUNDSIBLE_COMMUNITY_DISABLED=true` to remove access, or
`SOUNDSIBLE_COMMUNITY_URL=https://live.example.org` to use their own relay. A
custom value must be an HTTPS origin only: credentials, paths, queries and
fragments are rejected.

When Community is first opened, each local Soundsible account receives an
Ed25519 identity stored with its account configuration. Only signed control
requests leave the Station; the private key and Soundsible credentials do not.

For a real WebRTC relay smoke test after bringing up the stack, run both browser
engines and require a TURN-relayed pass as the release gate:

```bash
cd ui_web
COMMUNITY_SMOKE_API=http://127.0.0.1:18080 COMMUNITY_SMOKE_BROWSERS=chromium,firefox node scripts/community-smoke.mjs
COMMUNITY_SMOKE_API=http://127.0.0.1:18080 COMMUNITY_SMOKE_BROWSERS=firefox COMMUNITY_SMOKE_FORCE_RELAY=1 node scripts/community-smoke.mjs
```
