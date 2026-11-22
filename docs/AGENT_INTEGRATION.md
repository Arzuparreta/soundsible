# Soundsible Agent Integration Guide

This guide is for OpenClaw, Hermes agents, local assistants, and agent skills that need to control a running Soundsible Station Engine.

Soundsible is not a cloud music API. It is a self-hosted Station Engine, usually at:

```text
http://localhost:5005
```

On LAN or Tailscale, replace `localhost` with the Station host IP or hostname.

In desktop-engine mode, the base URL is not assumed to be `:5005`. Read the readiness JSON emitted by `python3 run.py --desktop-engine` / `soundsible_engine.py`, or query `/api/health` from the known loopback URL and use its reported `base_url`.

## Agent Rules

1. Use the Agent API for playback control: `/api/agent/*`, or the general device command endpoints `/api/devices/<device_id>/commands` and `/api/devices/transfer` (with `playback:control` scope).
2. Do not invent device IDs. Read `/api/devices` and target a real `device_id` or exact `device_name`.
3. Every command returns a final status: `200` `{"status": "applied", "rev": n}`, `400`/`404`/`409` `{"status": "rejected", "reason": "..."}`, or `503`/`504` `{"status": "unreachable", "reason": "offline" | "timeout"}`. Commands never answer `"sent"` and never write playback state on a device's behalf.
4. Deezer is metadata only. Soundsible never plays Deezer audio.
5. For playable search results outside the library, use YouTube / YouTube Music search through the downloader's yt-dlp path.
6. Each player keeps its own up-next list; the engine has no playback queue an agent can add to. The download queue only downloads.
7. Use `/api/agent/play` for "play this now" and `/api/agent/command` (`next`, `previous`, `pause`, `play`, `seek`) to move through what the player has queued.

## Authentication

Agent endpoints require a Soundsible agent token.

Agent tokens are now stored in scoped `auth_tokens` records. Legacy `agent_tokens` compatibility still exists internally, but new integrations should treat the scoped token model as the source of truth.

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

You can optionally request a narrower scope set when creating a token:

```bash
curl -X POST http://localhost:5005/api/agent/token \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <SOUNDSIBLE_ADMIN_TOKEN>' \
  -d '{"name":"openclaw","scopes":["library:read","playback:control"]}'
```

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
| Player session | What a device is playing, reported by the device; the web player and Android also report what they have up next (`session.queue`), the iOS app does not yet | `GET /api/playback/state` (read only) |
| Download queue | Background jobs that download tracks into the library | `POST /api/downloader/queue` |

The active player is normally a browser tab, PWA, desktop shell, or Android app. Each running copy registers as an instance of its `device_id` over Socket.IO (`playback_register`), declaring its protocol version and supported commands.

Agent HTTP commands dispatch `device_command` directly to the device's owning Socket.IO instance and wait for its acknowledgement (5 seconds, or 10 seconds for `session.import` during transfer). If the device is offline, does not support the protocol, does not declare the command, or fails to acknowledge in time, the engine returns `unreachable` or `rejected` directly rather than pretending the command succeeded.

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
      "device_type": "web",
      "form_factor": "computer",
      "online": true,
      "socket_active": true,
      "protocol": 1,
      "commands": ["transport.play", "transport.pause", "transport.next", "transport.previous", "transport.seek", "play.tracks"],
      "playing": {
        "track": { "id": "track-id", "title": "One More Time", "artist": "Daft Punk" },
        "is_playing": true,
        "position_sec": 42.1,
        "measured_at_ms": 1763820000000,
        "mode": "normal",
        "rev": 17
      }
    }
  ],
  "server_now_ms": 1763820001000
}
```

How agents should choose a device:

1. Prefer a device with `online: true` and `protocol` set (non-null).
2. Prefer `device_type != "agent"` for playback.
3. If the user says "Desktop", target the device whose `device_name` is exactly `Desktop`, or use its `device_id`.
4. If there are no online devices, tell the user to open Soundsible in a browser, PWA, or app.

Register an agent device, optional but useful for discovery:

```bash
curl -X POST http://localhost:5005/api/devices/register \
  -H 'Content-Type: application/json' \
  -d '{"device_id":"openclaw-agent","device_name":"OpenClaw","device_type":"agent"}'
```

Browser and app players also register over Socket.IO. HTTP registration alone does not make a device controllable; `online: true` with a non-null `protocol` is the signal that a live player instance is connected and accepting commands.

## Control Playback

Both `/api/agent/command` and `/api/agent/play` run through the remote command dispatcher (`POST /api/devices/<device_id>/commands`) and return its HTTP status codes and JSON answers:

| HTTP | Body | Meaning |
|---|---|---|
| `200` | `{"status": "applied", "rev": 18}` | The target ran the command and published its updated state |
| `400` | `{"status": "rejected", "reason": "invalid"}` | Unknown command or invalid arguments |
| `404` | `{"status": "rejected", "reason": "unknown_device"}` | Target device not found (or no device registered) |
| `404` | `{"status": "rejected", "reason": "not_found"}` | Requested track or search query returned no playable item |
| `409` | `{"status": "rejected", "reason": "update_required" \| "unsupported" \| "invalid_state" \| "not_found" \| "locked" \| "needs_gesture" \| "nothing_playing"}` | Target rejected the command or does not support the protocol/command |
| `503` | `{"status": "unreachable", "reason": "offline"}` | Target has no connected Socket.IO instance |
| `504` | `{"status": "unreachable", "reason": "timeout"}` | Target did not acknowledge in time |

The legacy endpoints `POST /api/playback/remote-command` and `POST /api/playback/handoff` remain for one release as thin wrappers over `POST /api/devices/<device_id>/commands` and `POST /api/devices/transfer`, returning these same answer shapes.

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

Seek to an absolute position in the current track:

```bash
curl -X POST http://localhost:5005/api/agent/command \
  -H 'Authorization: Bearer <agent-token>' \
  -H 'Content-Type: application/json' \
  -d '{"command":"seek","position_sec":75.5,"device_id":"Desktop"}'
```

Seek uses absolute seconds from the start of the current track. To seek to 1:15, send `position_sec: 75`. To jump forward or backward, first read `/api/playback/state` or `/api/devices`, add or subtract seconds from `position_sec`, then send the new absolute value.

Supported commands:

```json
{"command":"pause"}
{"command":"play"}
{"command":"next"}
{"command":"previous"}
{"command":"seek","position_sec":75.5}
```

For `seek`, `position_sec` is required and must be a finite number greater than or equal to `0`. `position_ms` is also accepted for millisecond-based clients. The target player clamps positions beyond the loaded track duration to the end of the track.

If `device_id` is omitted, Soundsible targets the most recently seen non-agent device, preferring online devices.

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
2. If no library match is found, it searches YouTube through yt-dlp.
3. The engine dispatches `play.tracks` with the bounded track descriptor to the target player's owning instance.

Expected response when applied by a live device:

```json
{
  "status": "applied",
  "rev": 19
}
```

If the device is registered but offline, the engine returns HTTP `503`:

```json
{
  "status": "unreachable",
  "reason": "offline"
}
```

### Browser Autoplay Limitation

After a browser reload, the page may have no user activation. In that state, Chrome, Safari, and Firefox can reject audible `audio.play()` calls that originate from remote commands.

When the browser blocks audio start, the target responds with HTTP `409`:

```json
{
  "status": "rejected",
  "reason": "needs_gesture"
}
```

Agent behavior:

1. If `/api/agent/play` or `/api/agent/command` returns `status: "applied"`, the target ran the action and published its new state.
2. If it returns `409` with `reason: "needs_gesture"`, tell the user to tap play on that device to unlock browser audio.
3. Once the user has started audio in that page session, later remote play, pause, resume, skip, and seek commands work without this prompt.

This is a browser security policy, not a Soundsible API failure. To avoid it completely, use a native playback surface such as the Android app or desktop shell.

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
| `GET` | `/api/library/albums?sort=&genre=&year=` | Albums from the normalized catalog. `sort` is one of `newest`, `alphabeticalByName`, `alphabeticalByArtist`, `byYear`, `byGenre`, `random`, `frequent`, `recent`, `highest`; an unknown one is a 400 |
| `GET` | `/api/library/albums/<album_id>` | One record and its track ids, in disc and track order |
| `GET` | `/api/library/artists` | Artists with a track to their name, from `track_artists` |
| `GET` | `/api/library/artists/<artist_id>` | One artist: the tracks they perform on, and the records they are credited with |
| `GET` | `/api/library/genres` | Genres present, with song and album counts |
| `GET` | `/api/library/years` | Release years present, with album and track counts |
| `POST` | `/api/library/scan` | Start an asynchronous scan of configured music roots; optional body `{"path":"..."}` must stay inside one |
| `GET` | `/api/library/scan` | Current or last scan state and counters |
| `GET` | `/api/library/saved-entities` | This account's bookmarked albums and artists, newest first: `{"entities":[...]}` |
| `PUT` | `/api/library/saved-entities` | Idempotent save/remove, body `{"saved":true,"entry":{"kind":"album","name":"Record","artist":"Band","destination":"/album/Record?artist=Band&deezer_id=123","cover":"https://..."}}`; requires `library:write` |
| `GET` | `/api/library/favourites` | Favorite track IDs (only the ones you own a file for) |
| `GET` | `/api/library/favourites/entries` | All saved songs, downloaded or not: `{"version":2,"favourites":[{"keys":[...],"title","artist",...}]}` |
| `POST` | `/api/library/favourites/toggle` | Toggle favorite, body `{"track_id":"..."}` or `{"favourite":{"keys":["yt:<video_id>"],"title":"...","artist":"..."}}` |
| `POST` | `/api/library/saved/set` | Save or remove many songs at once, body `{"saved":true,"entries":[{"keys":[...],"title":"...","artist":"..."}]}`, at most 500 entries. Never flips a song: saving skips songs already saved, and removing keeps favourites and songs held as files. Returns `{"changed":N}`; requires `library:write` |
| `POST` | `/api/catalog/album/download` | Download every song on a Deezer album the library does not hold yet, body `{"deezer_id":"302127"}`. Returns `202` with the job. An open job for the album is returned as is, a stopped one is resumed, and a finished one gives way to a new pass; requires `library:write` |
| `GET` | `/api/catalog/album/download?deezer_id=` | That album's latest download, song by song (`state`, `candidates`), or `null`. Doubtful matches wait in `needs_review`: decide them with `POST /api/migration/jobs/<id>/decision`, and resume with `POST /api/migration/jobs/<id>/control` `{"action":"resume"}` |
| `GET` | `/api/catalog/artist/discography?deezer_id=` | An artist's albums, then singles and EPs, as one `tracklist` with each recording once (one ISRC); compilations are left out. Also `releases` (with their `track_ids`), `partial_failures` (releases that could not be read) and `truncated` (past 2000 songs) |
| `POST` | `/api/catalog/artist/download` | Download that discography: every song the library lacks, each filed on its own release. Same job rules as the album route; requires `library:write` |
| `GET` | `/api/catalog/artist/download?deezer_id=` | That artist's latest download, song by song, or `null` |
| `POST` | `/api/library/playlists` | Create playlist, body `{"name":"..."}` |
| `POST` | `/api/library/playlists/<name>/tracks` | Add track to playlist, body `{"track_id":"..."}` |
| `DELETE` | `/api/library/playlists/<name>/tracks/<track_id>` | Remove track from playlist |

Album and artist bookmarks are navigation references, independent of saved songs,
favourites and downloads. `kind` is `album` or `artist`; `name` and an internal
`destination` are required. Optional `artist` and `cover` preserve display metadata.
The server derives identity keys from `album_id`/`artist_id` and `deezer_id` in the
destination, and assigns `id` and `added_at`. References without ids remain
unresolved; names alone never merge with identified editions or artists. Both
methods return the full collection. Use `saved: false` with the same entry to
remove it. The per-user `saved_entities_updated` event invalidates cached reads.
The route and the web player's bookmark controls touch only the bookmark.
Adding every song to Songs and downloading a collection are separate, explicit
commands in the album or artist page's overflow menu. The same tray opens from
the header photo or name with a left/right click, keyboard activation, or a
mobile long press. Removing a bookmark never
removes saved songs or downloads.
Failed persistence returns an error without discarding the previous collection;
instance backups include the account's `saved_entities.json` automatically.

The web Library root (`#/`, also `#/library`) contains collection shortcuts and
saved album/artist rows. Songs, albums and artists open at
`#/library?view=songs|albums|artists`; saved collections open at
`#/?saved=albums|artists`. All of these subentries are selectable in the bottom
bar settings. Selecting Library itself always returns to its root. The NORMAL/DJ
browser retains its existing sections, with an additional Saved section. On
desktop, the sidebar subentries switch between songs, albums and artists; the
library search sits below the title beside the sorting control.

Mutation routes may require admin authorization or trusted LAN/Tailscale access.

Folder scans require `library:write`. A successful start returns HTTP `202`;
poll the `GET` route until `state` is `completed` or `failed`. Repeating the
start during `queued` or `scanning` returns the same `scan_id`. Scans are
additive: use the separate purge route when missing source files should be
removed from the catalog.

## Download Queue

This queue downloads audio into the persistent library. It does not play anything.

Use this endpoint only when the user wants to **download/import music into the library**:

```http
POST /api/downloader/queue
```

The request body is always an object with an `items` array:

```json
{
  "items": [
    {
      "song_str": "..."
    }
  ]
}
```

Do not send a bare item object. Do not send a bare `video_id`. Do not send `preview` objects here.

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

`source=ytmusic` and `source=music` search YouTube Music. `source=youtube` searches regular YouTube.

Peek a YouTube URL or ID, without queueing or downloading:

```bash
curl 'http://localhost:5005/api/downloader/youtube/peek?id=dQw4w9WgXcQ'
```

### Download Queue Item Formats

There are three supported music item shapes.

#### 1. Recommended: resolved YouTube / YouTube Music result

Use this when the agent has searched `/api/downloader/youtube/search` and selected a result. Send a full YouTube URL in `song_str` and include `video_id`.

If the search result has `webpage_url`, use it. If it only has an 11-character `id`, build:

```text
https://www.youtube.com/watch?v=<id>
```

Example:

```bash
curl -X POST http://localhost:5005/api/downloader/queue \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <SOUNDSIBLE_ADMIN_TOKEN>' \
  -d '{
    "items": [
      {
        "source_type": "ytmusic_search",
        "song_str": "https://www.youtube.com/watch?v=FGBhQbmPwH8",
        "video_id": "FGBhQbmPwH8",
        "display_title": "One More Time",
        "display_artist": "Daft Punk",
        "duration_sec": 320,
        "thumbnail_url": "https://img.youtube.com/vi/FGBhQbmPwH8/mqdefault.jpg",
        "metadata_evidence": {
          "title": "One More Time",
          "artist": "Daft Punk",
          "album": "Discovery"
        }
      }
    ]
  }'
```

Use `source_type: "ytmusic_search"` for a result selected from YouTube Music search. Use `source_type: "youtube_search"` for a result selected from regular YouTube search. Use `source_type: "youtube_url"` for a user-provided YouTube URL.

Important: explicit YouTube source types require a YouTube URL in `song_str`. This is invalid:

```json
{
  "items": [
    {
      "source_type": "ytmusic_search",
      "song_str": "Daft Punk One More Time"
    }
  ]
}
```

#### 2. User-provided YouTube URL

Use this when the user gives a YouTube URL directly. `source_type` is optional because Soundsible can infer YouTube URLs, but including it is clearer.

```bash
curl -X POST http://localhost:5005/api/downloader/queue \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <SOUNDSIBLE_ADMIN_TOKEN>' \
  -d '{
    "items": [
      {
        "source_type": "youtube_url",
        "song_str": "https://www.youtube.com/watch?v=FGBhQbmPwH8",
        "video_id": "FGBhQbmPwH8"
      }
    ]
  }'
```

Do not send only the video id:

```json
{
  "items": [
    {
      "video_id": "FGBhQbmPwH8"
    }
  ]
}
```

That is rejected because the downloader needs `song_str` to say what to download.

#### 3. Plain text fallback

Use this only when the agent has no resolved YouTube result yet and wants Soundsible to search during processing. Do not set `source_type`.

```bash
curl -X POST http://localhost:5005/api/downloader/queue \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <SOUNDSIBLE_ADMIN_TOKEN>' \
  -d '{
    "items": [
      {
        "song_str": "Daft Punk - One More Time",
        "metadata_evidence": {
          "title": "One More Time",
          "artist": "Daft Punk"
        }
      }
    ]
  }'
```

This path is less precise. For agent workflows, prefer searching first, selecting a result, then queueing the resolved URL format.

### Accepted Response

Successful queueing returns accepted item IDs:

```json
{
  "status": "queued",
  "ids": ["download-job-id"],
  "accepted": [
    {
      "index": 0,
      "id": "download-job-id",
      "source_type": "ytmusic_search"
    }
  ],
  "rejected": []
}
```

Partial failure is possible. Always inspect both `accepted` and `rejected`.

Common rejected reasons:

| Reason | Meaning | Fix |
|---|---|---|
| `No JSON data received` | Body was empty or not JSON | Send `Content-Type: application/json` and a JSON object |
| `Item must be an object` | An `items` entry was not an object | Put objects inside `items` |
| `Missing source_type/song_str` | No usable input | Include `song_str` |
| `Invalid or unsupported YouTube URL or missing video_id` | Explicit YouTube source type had no full YouTube URL/video id | Send full URL in `song_str` and `video_id` |
| `Playlist-only or invalid YouTube URL (missing v=)` | URL is not a single video URL | Pick a specific video |
| `This link type is not supported` | Spotify link or unsupported source | Resolve through YouTube Music first |

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

### Agent Decision Rules for Downloads

1. If the user says "download this YouTube link", queue `source_type: "youtube_url"` with `song_str` as the full URL.
2. If the user says "download Song by Artist", first call `/api/downloader/youtube/search?source=ytmusic`, pick the best result, then queue the resolved URL format.
3. If search is unavailable or inconclusive, queue plain text with only `song_str` and optional `metadata_evidence`; do not add `source_type`.
4. Never use Deezer IDs, Spotify URLs, preview objects, or raw `video_id`-only payloads for `/api/downloader/queue`.
5. After queueing, call `/api/downloader/start`; queueing alone does not begin processing.

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

Players may also publish a `session` object alongside it — the queue, the
transport preferences and the DJ workspace behind the song — which is
what lets another device pick the session up rather than just the track. It is a
delta: omit the key and whatever is stored for that device is kept, send `null`
to end it. Agents have no reason to write one, and an agent that starts an
unrelated song on a device should send `"session": null` so the device does not
restore a queue that track is not in. Sessions over 256 KB are dropped.

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
curl -X POST http://localhost:5005/api/devices/transfer \
  -H 'Content-Type: application/json' \
  -d '{"from_device_id":"dev-phone","to_device_id":"dev-desktop"}'
```

(`POST /api/playback/handoff` stays for one release as a wrapper over `POST /api/devices/transfer` with the same body and answers.)

Transfer behavior:

1. Sends `session.export` to `from_device_id` (or uses its last published state if it is offline or has no protocol). If no track is playing, returns `409` `{"status": "rejected", "reason": "nothing_playing", "step": "export"}`.
2. Sends `session.import` to `to_device_id` (10 s timeout). If this fails, returns the failure with `"step": "import"` and leaves `from_device_id` playing.
3. Only after `to_device_id` answers `applied`, sends `session.release` to `from_device_id` if it is online (failures here are logged and the answer stays `applied`).

Seek behavior:

1. `POST /api/agent/command` with `{"command":"seek","position_sec":...}` dispatches `transport.seek` to the target's owning instance and waits for its acknowledgement.
2. The engine never writes playback state on the device's behalf; the player seeks and publishes its updated state before acknowledging `applied`.
3. If nothing is playing on the target, the target answers `409` `{"status": "rejected", "reason": "nothing_playing"}` (or `invalid_state`).

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
| `GET` | `/api/podcasts/episodes-by-url?rss_url=...` | A feed's show (`title`, `author`, `image_url`) and episodes, without subscribing |
| `POST` | `/api/podcasts/enclosure/peek` | Create a stream token for an enclosure |
| `GET` | `/api/podcasts/stream/<token>` | Stream podcast audio |

Podcast preview queue items use `enclosure_url`, not `video_id`.

## Recommended Agent Skill Flow

For "play X on my desktop":

1. Verify token with `GET /api/agent/verify`.
2. Read devices with `GET /api/devices`.
3. Select `Desktop` with `online: true` and `protocol` set; if missing, ask the user to open `/player/desktop/`.
4. Call `POST /api/agent/play` with `{"query":"X","device_id":"Desktop"}`.
5. Check the response: `applied` means the target played and published; `unreachable` (`offline`/`timeout`) or `rejected` (`needs_gesture`, `update_required`, etc.) explains why it did not.

For "add X to the queue": the up-next list belongs to the player, and there is
no endpoint that adds to it. Offer to play X now (`/api/agent/play`) or to
download it into the library (`/api/downloader/queue`).

For "seek to 1:15" or "jump to 75 seconds":

1. Read devices with `GET /api/devices` and target an active browser player.
2. Send `POST /api/agent/command` with `{"command":"seek","position_sec":75,"device_id":"Desktop"}`.
3. For relative seeking, read `/api/playback/state`, compute the new absolute position, then send `seek`.

For "download X":

1. Search YouTube Music: `GET /api/downloader/youtube/search?q=X&source=ytmusic&limit=5`.
2. Pick the best result. Use `webpage_url` as `song_str`; if missing, build `https://www.youtube.com/watch?v=<id>`.
3. Queue it with `POST /api/downloader/queue` as `{"items":[{"source_type":"ytmusic_search","song_str":"https://www.youtube.com/watch?v=<id>","video_id":"<id>","display_title":"...","display_artist":"..."}]}`.
4. Start processing with `POST /api/downloader/start`.
5. Poll `/api/downloader/queue/status`.
6. Refresh library after completion.

For "download this YouTube URL":

1. Queue it with `POST /api/downloader/queue` as `{"items":[{"source_type":"youtube_url","song_str":"<full-youtube-url>"}]}`.
2. Start processing with `POST /api/downloader/start`.

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
| `503 unreachable` (`offline`) | Device is registered but has no connected Socket.IO instance | Open/reload the player on that device |
| `504 unreachable` (`timeout`) | Target instance did not acknowledge the command in time | Retry or check the player tab/app |
| `404 rejected` (`unknown_device`) | Agent used an unknown device ID/name, or no device is registered | Call `/api/devices` and target a real device |
| `409 rejected` (`update_required`) | Device is online without a remote-control protocol (older app) | Update Soundsible on that device |
| `409 rejected` (`needs_gesture`) | Browser autoplay policy blocked audio start after a fresh reload | Ask the user to tap play on that device once |
| `400 rejected` (`invalid`) on seek | Agent sent `seek` without a valid non-negative `position_sec` | Send `{"command":"seek","position_sec":75}` |
| `409 rejected` (`nothing_playing`) | Target device has no current track | Start playback first or target the active device from `/api/devices` |
| Deezer ID fails | Deezer IDs are metadata only | Resolve by title/artist through YouTube Music |
| Download queue rejects raw `video_id` | `/api/downloader/queue` requires `items[].song_str` | Send full YouTube URL in `song_str` plus `video_id` |
| Download queue rejects `ytmusic_search` with plain text | Explicit YouTube source types require resolved YouTube URLs | Search first, then queue the selected result URL; or omit `source_type` for plain text fallback |
| Downloaded song not visible | Download job not finished or library not synced | Check `/api/downloader/queue/status`, then `/api/library/sync` if needed |

## Minimal OpenAPI-Style Summary

```text
GET  /api/health
GET  /api/devices
POST /api/devices/register
POST /api/devices/<device_id>/commands
POST /api/devices/transfer

POST /api/agent/token          admin
GET  /api/agent/verify         agent token
POST /api/agent/play           agent token
POST /api/agent/command        agent token; pause/play/next/previous/seek
GET  /api/agent/debug/socketio agent token

GET  /api/library
GET  /api/library/search?q=
GET  /api/library/albums
GET  /api/library/albums/<album_id>
GET  /api/library/artists
GET  /api/library/artists/<artist_id>
GET  /api/library/genres
GET  /api/library/years
GET  /api/library/favourites
GET  /api/library/favourites/entries
POST /api/library/favourites/toggle
POST /api/library/playlists
POST /api/library/playlists/<name>/tracks

GET    /api/playback/state
PUT    /api/playback/state
POST   /api/playback/remote-command   wrapper over /api/devices/<id>/commands
POST   /api/playback/handoff          wrapper over /api/devices/transfer

GET  /api/downloader/youtube/search?q=&limit=&source=
GET  /api/downloader/youtube/peek?id=
POST /api/downloader/queue    admin/trusted
GET  /api/downloader/queue/status
POST /api/downloader/start    admin/trusted

GET /api/discovery/deezer/<allowlisted-path>
GET /api/discovery/podcasts/search?q=
GET /api/discovery/podcasts/top
```
