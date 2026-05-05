# Soundsible Agent Integration Guide

This guide is for OpenClaw, Hermes agents, local assistants, and agent skills that need to control a running Soundsible Station Engine.

Soundsible is not a cloud music API. It is a self-hosted Station Engine, usually at:

```text
http://localhost:5005
```

On LAN or Tailscale, replace `localhost` with the Station host IP or hostname.

## Agent Rules

1. Use the Agent API for playback control: `/api/agent/*`.
2. Do not invent device IDs. Read `/api/devices` and target a real `device_id` or exact `device_name`.
3. If a response includes `warning: "Device appears offline (no active socket)"`, the command was emitted but no browser player is currently connected to that device room.
4. Deezer is metadata only. Soundsible never plays Deezer audio.
5. For playable search results outside the library, use YouTube / YouTube Music search through the ODST / yt-dlp path.
6. The playback queue is not the same as the download queue.
7. Prefer `/api/agent/play` for "play this now". Prefer `/api/playback/queue` for "add this to the player queue".

## Authentication

Agent endpoints require a Soundsible agent token.

Create a token:

```bash
curl -X POST http://localhost:5005/api/agent/token \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <SOUNDSIBLE_ADMIN_TOKEN>' \
  -d '{"name":"openclaw"}'
```

If `SOUNDSIBLE_ADMIN_TOKEN` is not configured, admin routes are allowed only from trusted LAN/Tailscale networks.

The response includes the raw token once:

```json
{
  "token": "raw-token-value",
  "token_id": "uuid",
  "name": "openclaw",
  "created_at": "2026-05-05 18:00:00"
}
```

Store the raw token in the agent secret store. Soundsible stores only a hash.

Use one of these headers on protected agent routes:

```text
Authorization: Bearer <agent-token>
X-Soundsible-Agent-Token: <agent-token>
```

Verify a token:

```bash
curl http://localhost:5005/api/agent/verify \
  -H 'Authorization: Bearer <agent-token>'
```

## Mental Model

Soundsible has three independent concepts:

| Concept | Purpose | Important endpoint |
|---|---|---|
| Library | Persistent downloaded/imported tracks and playlists | `GET /api/library` |
| Playback queue | In-memory queue consumed by the web player | `GET/POST /api/playback/queue` |
| Download queue | Background jobs that download tracks into the library | `POST /api/downloader/queue` |

The active player is normally a browser tab or PWA at `/player/` or `/player/desktop/`. The player registers a device and joins a Socket.IO room:

```text
playback:{scope}:{device_id}
```

Current scope is `default`.

Agent HTTP commands emit Socket.IO events into the target device room. If the target browser is not connected, Soundsible can accept the request but the device will not react.

## Devices

List devices:

```bash
curl http://localhost:5005/api/devices
```

Example response:

```json
{
  "devices": [
    {
      "device_id": "dev-1775490811387-hu7wrzro8",
      "device_name": "Desktop",
      "device_type": "desktop",
      "scope": "default",
      "active_sid": "abc123",
      "socket_connected": true,
      "last_seen_ts": 1775490830.0
    }
  ]
}
```

How agents should choose a device:

1. Prefer a device with `active_sid` set.
2. Prefer `device_type != "agent"` for playback.
3. If the user says "Desktop", target the device whose `device_name` is exactly `Desktop`, or use its `device_id`.
4. If there are no devices with `active_sid`, tell the user to open Soundsible in a browser or PWA.

Register an agent device, optional but useful for discovery:

```bash
curl -X POST http://localhost:5005/api/devices/register \
  -H 'Content-Type: application/json' \
  -d '{"device_id":"openclaw-agent","device_name":"OpenClaw","device_type":"agent"}'
```

Browser players also register over Socket.IO. HTTP registration alone does not make a device controllable; `active_sid` is the signal that a real Socket.IO player is connected.

## Control Playback

Pause a target device:

```bash
curl -X POST http://localhost:5005/api/agent/command \
  -H 'Authorization: Bearer <agent-token>' \
  -H 'Content-Type: application/json' \
  -d '{"command":"pause","device_id":"Desktop"}'
```

Resume the current track on a target device:

```bash
curl -X POST http://localhost:5005/api/agent/command \
  -H 'Authorization: Bearer <agent-token>' \
  -H 'Content-Type: application/json' \
  -d '{"command":"play","device_id":"Desktop"}'
```

Skip to next:

```bash
curl -X POST http://localhost:5005/api/agent/command \
  -H 'Authorization: Bearer <agent-token>' \
  -H 'Content-Type: application/json' \
  -d '{"command":"next","device_id":"Desktop"}'
```

Supported commands:

```json
{"command":"pause"}
{"command":"play"}
{"command":"next"}
```

If `device_id` is omitted, Soundsible targets the most recently registered non-agent device, preferring devices with an active socket.

## Play Music Now

Play a library track by ID:

```bash
curl -X POST http://localhost:5005/api/agent/play \
  -H 'Authorization: Bearer <agent-token>' \
  -H 'Content-Type: application/json' \
  -d '{"track_id":"<library-track-id>","device_id":"Desktop"}'
```

Play by search query:

```bash
curl -X POST http://localhost:5005/api/agent/play \
  -H 'Authorization: Bearer <agent-token>' \
  -H 'Content-Type: application/json' \
  -d '{"query":"Daft Punk One More Time","device_id":"Desktop"}'
```

Search behavior:

1. Soundsible searches the local library first.
2. If no library match is found, it searches YouTube Music through yt-dlp.
3. The target player receives either a library track payload or a preview payload.

Expected response when sent to a live device:

```json
{
  "status": "sent",
  "device_id": "dev-...",
  "track": {
    "id": "track-or-video-id",
    "title": "Track title",
    "artist": "Artist"
  }
}
```

If the device is registered but offline:

```json
{
  "status": "sent",
  "device_id": "dev-...",
  "warning": "Device appears offline (no active socket)"
}
```

Treat that as not actually played.

### Browser Autoplay Limitation

After a browser reload, the page may have no user activation. In that state, Chrome, Safari, and Firefox can reject audible `audio.play()` calls that originate from Socket.IO or HTTP-triggered agent commands.

Soundsible handles this by staging the remote request in the player. The target device shows a **Remote playback is ready** prompt with the requested track. One tap starts the staged playback and unlocks the browser audio session for later agent commands in that page session.

Agent behavior:

1. If `/api/agent/play` returns `status: "sent"` and the device has `active_sid`, the command reached the browser.
2. If playback does not audibly start immediately after a fresh reload, tell the user to tap the remote playback prompt on that device.
3. Once the user has started any audio in that page session, later agent playback, pause, resume, and next commands should work without this prompt.

This is a browser security policy, not a Soundsible API failure. To avoid the prompt completely, use a native playback surface or server-side playback engine instead of browser audio.

## Library

Get the full library:

```bash
curl http://localhost:5005/api/library
```

Search library:

```bash
curl 'http://localhost:5005/api/library/search?q=radiohead'
```

The library response includes persistent tracks. A normal track has a stable Soundsible `id`. Use that `id` for:

```json
{"track_id":"<id>"}
```

Useful library routes:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/library` | Full library metadata |
| `GET` | `/api/library/search?q=...` | Search local library |
| `GET` | `/api/library/favourites` | Favorite track IDs |
| `POST` | `/api/library/favourites/toggle` | Toggle favorite, body `{"track_id":"..."}` |
| `POST` | `/api/library/playlists` | Create playlist, body `{"name":"..."}` |
| `POST` | `/api/library/playlists/<name>/tracks` | Add track to playlist, body `{"track_id":"..."}` |
| `DELETE` | `/api/library/playlists/<name>/tracks/<track_id>` | Remove track from playlist |

Mutation routes may require admin authorization or trusted LAN/Tailscale access.

## Playback Queue

This is the queue the browser player consumes when the user or agent asks for "next".

Read queue:

```bash
curl http://localhost:5005/api/playback/queue
```

Add a library track:

```bash
curl -X POST http://localhost:5005/api/playback/queue \
  -H 'Content-Type: application/json' \
  -d '{"track_id":"<library-track-id>"}'
```

Add a YouTube preview item:

```bash
curl -X POST http://localhost:5005/api/playback/queue \
  -H 'Content-Type: application/json' \
  -d '{
    "preview": {
      "video_id": "dQw4w9WgXcQ",
      "title": "Example",
      "artist": "Artist",
      "duration": 213,
      "thumbnail": "https://..."
    }
  }'
```

Queue operations:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/playback/queue` | Queue contents |
| `POST` | `/api/playback/queue` | Add library track or preview |
| `DELETE` | `/api/playback/queue/<index>` | Remove by queue index |
| `DELETE` | `/api/playback/queue/track/<track_id>` | Remove all queue entries with ID |
| `POST` | `/api/playback/queue/move` | Body `{"from_index":0,"to_index":1}` |
| `DELETE` | `/api/playback/queue` | Clear queue |
| `GET` | `/api/playback/next` | Pop next item |
| `POST` | `/api/playback/repeat` | Body `{"mode":"off"|"all"|"one"|"once"}` |
| `POST` | `/api/playback/shuffle` | Shuffle current queue |

Important: `/api/playback/next` pops an item. Do not call it just to inspect the queue.

## Download Queue

This queue downloads audio into the persistent library. It is not the same as playback queue.

Search YouTube / YouTube Music:

```bash
curl 'http://localhost:5005/api/downloader/youtube/search?q=Daft%20Punk%20One%20More%20Time&limit=5&source=ytmusic'
```

Valid `source` values:

```text
ytmusic
music
youtube
```

Peek a YouTube URL or ID:

```bash
curl 'http://localhost:5005/api/downloader/youtube/peek?id=dQw4w9WgXcQ'
```

Queue downloads:

```bash
curl -X POST http://localhost:5005/api/downloader/queue \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <SOUNDSIBLE_ADMIN_TOKEN>' \
  -d '{
    "items": [
      {
        "song_str": "Daft Punk One More Time",
        "source_type": "ytmusic_search"
      }
    ]
  }'
```

Start processing:

```bash
curl -X POST http://localhost:5005/api/downloader/start \
  -H 'Authorization: Bearer <SOUNDSIBLE_ADMIN_TOKEN>'
```

Check download queue:

```bash
curl http://localhost:5005/api/downloader/queue/status
```

When downloads finish, Soundsible emits `library_updated` and the track appears in `/api/library`.

## Deezer Discovery

Deezer routes are metadata only.

Allowed proxy paths:

```text
chart
search
playlist/<numeric-id>
track/<numeric-id>
artist/<numeric-id>/top
```

Examples:

```bash
curl 'http://localhost:5005/api/discovery/deezer/search?q=daft%20punk'
curl 'http://localhost:5005/api/discovery/deezer/chart'
curl 'http://localhost:5005/api/discovery/deezer/playlist/3155776842'
```

Deezer track IDs are not playable Soundsible track IDs. A Deezer row is a metadata suggestion. To play it:

1. Extract `title` and `artist.name` from the Deezer response.
2. Search YouTube Music: `/api/downloader/youtube/search?q=<artist title>&source=ytmusic`.
3. Pick the best result.
4. Either:
   - play now with `/api/agent/play` using the query, or
   - add a preview item to `/api/playback/queue`, or
   - add it to `/api/downloader/queue` to download it into the library.

Do not call `/api/agent/play` with `track_id: "deezer_123"` or a raw Deezer numeric ID.

## Playback State, Resume, and Handoff

Players periodically write state:

```http
PUT /api/playback/state
```

State includes:

```json
{
  "track_id": "track-or-video-id",
  "position_sec": 42.5,
  "is_playing": true,
  "device_id": "dev-...",
  "device_name": "Desktop",
  "device_type": "desktop"
}
```

Read state:

```bash
curl http://localhost:5005/api/playback/state
```

Read state from another device, excluding the current device:

```bash
curl 'http://localhost:5005/api/playback/state?exclude_device=<device-id>'
```

Move playback from one device to another:

```bash
curl -X POST http://localhost:5005/api/playback/handoff \
  -H 'Content-Type: application/json' \
  -d '{"from_device_id":"dev-phone","to_device_id":"dev-desktop"}'
```

Handoff behavior:

1. Reads state from `from_device_id`.
2. Emits `playback_stop_requested` to `playback:default:<from_device_id>`.
3. Writes target playback state with `to_device_id`.
4. Emits `playback_start_requested` to `playback:default:<to_device_id>`.

If `to_device_id` has no active socket, the response includes an offline warning.

## Podcasts

Podcast discovery and playback is separate from music search.

Useful routes:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/discovery/podcasts/search?q=...` | Search podcast directory |
| `GET` | `/api/discovery/podcasts/top?country=US&limit=25` | Top podcasts |
| `GET` | `/api/podcasts/subscriptions` | Subscribed feeds |
| `POST` | `/api/podcasts/subscribe` | Subscribe by feed data |
| `GET` | `/api/podcasts/feeds/<feed_id>/episodes` | Episodes for a feed |
| `POST` | `/api/podcasts/enclosure/peek` | Create a stream token for an enclosure |
| `GET` | `/api/podcasts/stream/<token>` | Stream podcast audio |

Podcast preview queue items use `enclosure_url`, not `video_id`.

## Recommended Agent Skill Flow

For "play X on my desktop":

1. Verify token with `GET /api/agent/verify`.
2. Read devices with `GET /api/devices`.
3. Select `Desktop` with `active_sid`; if missing, ask the user to open `/player/desktop/`.
4. Call `POST /api/agent/play` with `{"query":"X","device_id":"Desktop"}`.
5. If the response has `warning`, report that the device is offline.

For "add X to the queue":

1. Search local library: `GET /api/library/search?q=X`.
2. If a good library match exists, `POST /api/playback/queue` with `{"track_id":"..."}`.
3. If not, search YouTube Music with `/api/downloader/youtube/search`.
4. Add the chosen result as `{"preview": {...}}`.

For "download X":

1. Queue a download with `POST /api/downloader/queue`.
2. Start processing with `POST /api/downloader/start`.
3. Poll `/api/downloader/queue/status`.
4. Refresh library after completion.

For "play this Deezer track":

1. Treat Deezer as metadata only.
2. Search YouTube Music for `artist + title`.
3. Play the YouTube Music match or add it as preview.

## Troubleshooting

Check device/socket state:

```bash
curl http://localhost:5005/api/agent/debug/socketio \
  -H 'Authorization: Bearer <agent-token>'
```

Common problems:

| Symptom | Meaning | Fix |
|---|---|---|
| `warning: Device appears offline` | Device is registered but has no active Socket.IO room join | Open/reload the player on that device |
| `Target device not found` | Agent used an unknown device ID/name | Call `/api/devices` and target a real device |
| Command returns `sent` but nothing plays | Usually no active socket or browser autoplay blocked | Check `active_sid`; after reload, tap the remote playback prompt once |
| Deezer ID fails | Deezer IDs are metadata only | Resolve by title/artist through YouTube Music |
| `/api/playback/next` changed queue | It pops the next item | Use `GET /api/playback/queue` to inspect |
| Downloaded song not visible | Download job not finished or library not synced | Check `/api/downloader/queue/status`, then `/api/library/sync` if needed |

## Minimal OpenAPI-Style Summary

```text
GET  /api/health
GET  /api/devices
POST /api/devices/register

POST /api/agent/token          admin
GET  /api/agent/verify         agent token
POST /api/agent/play           agent token
POST /api/agent/command        agent token
GET  /api/agent/debug/socketio agent token

GET  /api/library
GET  /api/library/search?q=
GET  /api/library/favourites
POST /api/library/favourites/toggle
POST /api/library/playlists
POST /api/library/playlists/<name>/tracks

GET    /api/playback/queue
POST   /api/playback/queue
DELETE /api/playback/queue/<index>
DELETE /api/playback/queue/track/<track_id>
POST   /api/playback/queue/move
DELETE /api/playback/queue
GET    /api/playback/state
PUT    /api/playback/state
POST   /api/playback/handoff
POST   /api/playback/notify-stop

GET  /api/downloader/youtube/search?q=&limit=&source=
GET  /api/downloader/youtube/peek?id=
POST /api/downloader/queue    admin/trusted
GET  /api/downloader/queue/status
POST /api/downloader/start    admin/trusted

GET /api/discovery/deezer/<allowlisted-path>
GET /api/discovery/podcasts/search?q=
GET /api/discovery/podcasts/top
```
