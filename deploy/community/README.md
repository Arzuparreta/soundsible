# Soundsible Community live stack

This stack relays live programme audio from a Soundsible Station to listeners.
It deliberately does not record audio, reconstruct tracks, ingest microphones,
store chat history, or implement song requests. Chat is a transient plain-text
room; a listener can type a request like any other message.

## Components and bounds

- `community-api`: signed DJ sessions, directory, synchronized programme
  metadata, presence, ephemeral cover cache and Socket.IO chat.
- `mediamtx`: one Opus WHIP publisher and WHEP readers per active session.
- Nginx: TLS and the single public origin.
- Defaults: 5 concurrent sessions, 100 listeners per session, 250 listeners
  total, 90 seconds for the DJ to reconnect.

The service keeps no replay. Closing a session removes its database lease and
uploaded artwork; chat messages are only emitted to clients currently in the
room.

## Host deployment

Copy `community_service/` and `deploy/community/` to a host with Docker Compose.
Create `deploy/community/.env` from `.env.example`, replace
`COMMUNITY_SECRET_KEY`, install `nginx-bootstrap.conf`, obtain the matching TLS
certificate, and replace it with `nginx.conf`. Then run:

```bash
docker compose --env-file deploy/community/.env \
  -f deploy/community/docker-compose.yml up -d --build
```

Expose TCP 80/443 and both UDP and TCP 8189. Ports 18080 and 18889 intentionally
bind only to loopback for Nginx.

Health and capacity can be checked with:

```bash
curl -fsS https://live.84-247-161-82.sslip.io/health
docker compose --env-file deploy/community/.env \
  -f deploy/community/docker-compose.yml ps
```

## Connect a Station

Set the public control-plane origin on the Soundsible service and restart it:

```bash
SOUNDSIBLE_COMMUNITY_URL=https://live.84-247-161-82.sslip.io
```

When Community is configured, each local Soundsible account receives an
Ed25519 identity stored with its account configuration. Only signed control
requests leave the Station; the private key and Soundsible credentials do not.

For a real local WebRTC relay smoke test after bringing up the stack:

```bash
cd ui_web
COMMUNITY_SMOKE_API=http://127.0.0.1:18080 node scripts/community-smoke.mjs
```
