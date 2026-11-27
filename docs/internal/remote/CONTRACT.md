# Remote control contract

How one Soundsible device controls the playback of another. Web (browser, PWA,
desktop shell) and the Android app implement both sides; the engine relays.
The native iOS app has never been installed (see `docs/IOS.md`) and does not
implement this contract; it keeps publishing state with
`PUT /api/playback/state`, which stays compatible.

## Rules

1. The playing device owns its playback. The engine never writes a device's
   playback state on its behalf.
2. A remote command runs the same function the device's own interface runs for
   the same action: `PlayerActions` on the web, the existing command handler in
   `PlaybackService` on Android. There are no remote-only behaviours. Remote
   behaviour equals local behaviour, DJ mode included.
3. Every command gets exactly one final answer: `applied`, `rejected` with a
   reason, or `unreachable`. Nothing answers "sent".
4. Commands set values (`transport.set_repeat {mode}`); none toggles.
5. Queue and DJ route entries are named by `queue_id`, never by index.
6. A controller shows a control only when the target declares the command.
   A new feature is a new command; devices that do not declare it never show
   it.
7. State travels device → engine → controllers as Socket.IO events. Controllers
   never poll.

## Devices and instances

A **device** is a persistent `device_id` (web: `localStorage`; Android: per
account profile). An **instance** is one running copy: one page load of the web
player, one start of the Android playback service. Two tabs of one browser are
one device with two instances.

### Registration — Socket.IO `playback_register`

```json
{
  "device_id": "…",
  "device_name": "Safari · iPhone",
  "device_type": "web | desktop | android | ios | agent | car",
  "form_factor": "phone | tablet | computer | tv",
  "instance_id": "random per instance",
  "protocol": 1,
  "commands": ["transport.play", "transport.pause", "…"]
}
```

- `device_type` keeps its existing meaning; `web` is now accepted instead of
  being rewritten to `desktop`.
- A registration without `instance_id` (an older app) uses its socket id as the
  instance id and has `protocol: null`.
- A device is **online** while at least one of its instances has a connected
  socket.
- The **owning instance** receives commands: the instance whose accepted state
  publication most recently had a non-null `track_id`; if that instance is not
  connected, the most recently connected instance.
- Default names, when the person never named the device: `<App or browser> ·
  <OS or device>`, for example `Safari · iPhone`, `Chrome · Android`,
  `Firefox · Linux`, `Soundsible · Windows` (desktop shell). No translated
  words, so no dictionary entry.
- `form_factor` on the web: Smart TV entrypoint (`/tv/`, `data-surface="tv"`) →
  `tv`; desktop shell → `computer`; coarse pointer with the shorter screen side
  under 600 CSS px → `phone`; other coarse pointer or `maxTouchPoints > 1` on a
  Mac user agent → `tablet`; otherwise `computer`.
  Android: `phone`, or `tablet` when the smallest width is ≥ 600 dp.
- Smart TV receivers register with `device_type: "web"`, `form_factor: "tv"`,
  and declare the tested `TV_REMOTE_COMMANDS` subset (excluding `dj.*`,
  `radio.*`, `transport.set_volume`, and `transport.set_muted`, and omitting
  `live.volume` from published state so controllers keep hardware/platform
  volume with the TV).

### Device row

`GET /api/devices` returns `{"devices": [row…], "server_now_ms": n}`. The
Socket.IO event `device_updated` carries `{"device": row, "server_now_ms": n}`
to the account room `user:{id}` whenever a row changes: an instance connects or
disconnects, a rename, an accepted state publication.

```json
{
  "device_id": "…",
  "device_name": "…",
  "device_type": "web",
  "form_factor": "phone",
  "online": true,
  "socket_active": true,
  "protocol": 1,
  "commands": ["…"],
  "playing": {
    "track": { "…": "the published track object" },
    "is_playing": true,
    "position_sec": 42.1,
    "measured_at_ms": 1763820000000,
    "mode": "normal | dj | radio | podcast",
    "rev": 17
  }
}
```

`playing` is `null` when the device published no track. `protocol` and
`commands` describe the owning instance. `socket_active` is kept for older
callers and equals `online`.

## Live state

### Publishing — `PUT /api/playback/state`

The existing body, plus:

| Field | Meaning |
| --- | --- |
| `instance_id` | The publishing instance. |
| `seq` | Integer, strictly increasing per instance. The engine drops a publication whose `seq` is not greater than the last accepted one for that instance and answers `{"status": "stale"}` with 200. |
| `live` | Object, at most 16 KiB, replaced on every publication (see below). |

`session` keeps its current meaning and delta rule: it is what a transfer
carries, and a publication that omits it keeps the stored one.

The engine answers an accepted publication with
`{"status": "ok", "rev": n}`. `rev` is an integer per device, increased by the
engine on every accepted publication, across instances.

When a device publishes:

- transport changes (play, pause, seek, track change, mix start): immediately,
  as today;
- session changes (queue, DJ route, sources, shuffle, repeat): within 250 ms
  of the change (debounced), instead of the 15 s interval;
- position while playing: every 15 s, as today. Position is never streamed.

### `live`

```json
{
  "phase": "loading | playing | paused | buffering | error | needs_gesture | idle",
  "duration": 213.4,
  "volume": { "level": 0.8, "muted": false },
  "dj": null
}
```

`dj` is non-null while DJ mode is on:

```json
{
  "phase": "the AutoPhase value",
  "repairing": false,
  "pending_direction": false,
  "mixing": true,
  "transition": { "status": "idle | armed | mixing", "next_queue_id": "…", "at": 180.2 }
}
```

`mixing` is the "Mix between songs" setting. `transition.next_queue_id` and
`at` are omitted when unknown. `volume` is omitted by a device that does not
declare `transport.set_volume`.

### Watching a device

- Socket.IO `watch_device {"device_id"}` with an acknowledgement. The engine
  joins the socket to `watch:{scope}:{device_id}` and acknowledges with
  `{"device": row, "state": state | null, "server_now_ms": n}`, where `state`
  includes the full stored `session`.
- `unwatch_device {"device_id"}` leaves the room. Disconnecting leaves it too.
- On every accepted publication the engine emits `device_state` to the watch
  room:

```json
{
  "device_id": "…", "rev": 18,
  "track_id": "…", "track": {}, "position_sec": 42.1, "is_playing": true,
  "measured_at_ms": 1763820000000, "live": {},
  "session": {},
  "server_now_ms": 1763820000040
}
```

`session` is present only when that publication carried the key (it may be
`null`: the session ended). A controller keeps its last session otherwise.

### Position on a controller

`offset = server_now_ms − Date.now()` at receipt. While `is_playing`, the
position is `position_sec + (Date.now() + offset − measured_at_ms) / 1000`,
clamped to `live.duration`. A controller ignores any state or row whose `rev`
is not greater than the one it holds.

## Commands

### `POST /api/devices/<device_id>/commands`

Requires the playback-control scope. Body: `{"name": "transport.pause", "args": {}}`.

The engine:

1. checks `name` against `shared/remote/commands.json` and `args` against the
   types listed there; track descriptors go through the same bounding as
   today's `_remote_track` (no paths, tokens or resolved URLs travel);
2. checks that the device exists, is online, has a protocol, and its owning
   instance declares `name`;
3. sends Socket.IO `device_command {"name", "args"}` to the owning instance's
   socket only, with `socketio.call`, and waits for its acknowledgement
   (5 s; 10 s for `session.import`);
4. returns the target's answer.

| HTTP | Body | When |
| --- | --- | --- |
| 200 | `{"status": "applied", "rev": n}` | The target ran the action and published. |
| 400 | `{"status": "rejected", "reason": "invalid"}` | Unknown command or bad arguments. |
| 404 | `{"status": "rejected", "reason": "unknown_device"}` | No such device for this account. |
| 409 | `{"status": "rejected", "reason": "…"}` | Reasons below. |
| 503 | `{"status": "unreachable", "reason": "offline"}` | No connected instance. |
| 504 | `{"status": "unreachable", "reason": "timeout"}` | No acknowledgement in time. |

Rejection reasons: `update_required` (online, no protocol: an older app),
`unsupported` (not declared), `invalid_state` (for example a `dj.*` command
while DJ mode is off), `not_found` (the `queue_id` is no longer there),
`locked` (the entry is armed or already mixing), `needs_gesture` (the browser
refused to start audio), `nothing_playing`.

### Target side

The target handles `device_command` by running the mapped action, then
publishing its state and waiting for the publication's answer, then
acknowledging `{"status": "applied", "rev": <rev from that answer>}` or
`{"status": "rejected", "reason": "…"}`. A command the instance does not
implement is answered `unsupported`. An action that throws is answered
`invalid_state`.

### Registry — `shared/remote/commands.json`

One file names every command and its argument types. The engine validates with
it; the web and Android tests read it so all three agree.

Types: `bool`, `number` (finite), `int`, `string` (≤ 512), `queue_id` (string ≤
128), `track` (bounded descriptor), `tracks` (1–500 descriptors),
`context` (object ≤ 4 KiB with string `id`, `kind`, `label`, optional
`cover`, `destination`), `state` (a playback state body ≤ 256 KiB),
`enum:a|b|c`. A trailing `?` marks an optional argument.

| Command | Arguments | Web runs | Android runs |
| --- | --- | --- | --- |
| `transport.play` | — | `resumePlayback` | `player.play()` |
| `transport.pause` | — | `pausePlayback` | `player.pause()` |
| `transport.next` | — | `autoSkip` in DJ mode, otherwise `next` | `seekToNextMediaItem` |
| `transport.previous` | — | `prev` | `seekToPreviousMediaItem` |
| `transport.seek` | `position_sec: number` | `seek` | `seekTo` |
| `transport.set_shuffle` | `on: bool` | `toggleShuffle` when different | `shuffleModeEnabled` |
| `transport.set_repeat` | `mode: enum:off\|all\|one` | `cycleRepeat` until equal | `repeatMode` |
| `transport.set_volume` | `level: number` (0–1) | `setVolume` | not declared |
| `transport.set_muted` | `on: bool` | `toggleMute` when different | not declared |
| `play.tracks` | `tracks: tracks`, `index: int`, `context: context?` | `playFrom` (in DJ mode it starts a DJ selection, as a local tap does) | the `queue` action |
| `queue.add` | `track: track`, `at: enum:next\|end` | `playNext` / `enqueue` (in DJ mode they place into the route) | the same paths as a local add |
| `queue.move` | `queue_id`, `before_queue_id: queue_id?` | `moveAutoRoute` in DJ mode, otherwise `moveInQueue` | `ProgramQueue.edit` move |
| `queue.remove` | `queue_id` | `removeAutoRouteOccurrence` in DJ mode, otherwise `removeQueueEntry` | `ProgramQueue.edit` remove |
| `queue.play_entry` | `queue_id` | `playQueueEntry` | seek to that entry |
| `radio.start` | `track: track` | `startRadio` | the `radio` action |
| `radio.stop` | — | `stopRadio` | the `radio` action |
| `dj.start` | `tracks: tracks`, `label: string` | `startDjSelection` | `djSelection` |
| `dj.start_from_current` | — | `enterAutoMode` | the `dj` action from the current item |
| `dj.stop` | — | `exitAutoMode` | the existing exit path |
| `dj.place` | `tracks: tracks`, `before_queue_id: queue_id?` | `placeAutoTracks` | `djRequest` |
| `dj.promote` | `queue_id` | `promoteInAutoRoute` | existing path if any |
| `dj.avoid` | `queue_id` | `avoidAutoTrackForSession` | existing path if any |
| `dj.add_source` | `tracks: tracks`, `label: string` | `addAutoSource` | `djSettings` |
| `dj.remove_source` | `source_id: string` | `removeAutoSource` | `djSettings` |
| `dj.change_session` | `tracks: tracks`, `label: string` | `changeAutoSession` | `djSettings` |
| `dj.repair` | — | `repairAutoRoute` | `djRepair` |
| `dj.set_mixing` | `on: bool` | `setDjMixing` | the `mixing` action |
| `session.export` | — | answers `applied` with `"state"`: the body it would publish, with the live position | same |
| `session.import` | `state: state` | restores the session and answers `applied` only once audio is playing | same |
| `session.release` | — | pauses; the session is now elsewhere | same |

A device declares only what it implements. Android leaves out anything it has
no existing handler for; gaps are listed in `HANDOFF.md`, never stubbed.
`session.*` are refused on the public endpoint (`invalid`): only transfer sends
them.

### Transfer — `POST /api/devices/transfer`

Body `{"from_device_id", "to_device_id"}`. In this order:

1. `session.export` to the source. If the source is offline or has no protocol,
   use its last published state. No track: `409 nothing_playing`.
2. `session.import` to the target (10 s). Any failure here is returned as is
   and the source keeps playing.
3. Only after `applied` from step 2: `session.release` to the source when it is
   online. A failure here is logged; the answer stays `applied`.

The answer has the command answer's shape plus `"step": "export | import"` on a
failure.

## Compatibility

- `POST /api/playback/remote-command` and `POST /api/playback/handoff` stay for
  one release as wrappers over the dispatcher and the transfer, for Android apps
  older than the engine. Their answers use this contract's shapes.
- The Socket.IO events `playback_stop_requested`, `playback_start_requested`,
  `playback_next_requested`, `playback_previous_requested` and
  `playback_seek_requested` are no longer sent. An online device without a
  protocol is shown as needing an update.
- The agent API (`/api/agent/play`, `/api/agent/command`) runs on the
  dispatcher and returns its answers.

## Controller behaviour

- Each player session starts on this device. An explicit remote selection
  survives socket reconnects during that session.
- "Copy track" reads the peer’s current track and estimates its position from
  the device row. The local player loads that track independently and sends no
  playback command to the source.
- When the device row reports DJ mode, its action becomes "Move DJ here" and
  uses the session transfer contract.


- A control is pending from the request until the answer. On `applied` it
  stays pending until the controller holds a state with `rev` ≥ the answer's
  `rev` (at most 3 s), so the interface never jumps back.
- Messages for answers that are not `applied`: offline → "{device} is not
  reachable"; timeout → "{device} didn't respond"; `update_required` → "Update
  Soundsible on {device} to control it"; `unsupported` → "{device} can't do
  that"; `locked` → "That song is already mixing in"; `not_found` → "That song
  is no longer in the queue"; `needs_gesture` → "Tap play on {device} to allow
  sound"; `nothing_playing` → "Nothing is playing on {device}"; anything else →
  "{device} couldn't do that".
