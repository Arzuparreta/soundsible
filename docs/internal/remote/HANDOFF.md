# Handoff: remote control

Controlling another device's playback — transport, queue, DJ session and
transfer — from any Soundsible device. The wire contract is
[CONTRACT.md](CONTRACT.md); read it first.

## Why it was rebuilt

Before this work a phone could send five transport commands it got no answer
for, send one song (which ended a DJ session on the receiving device), or move
the whole session. Faults found in the old pipeline:

- `POST /api/playback/remote-command` answered `sent` without knowing whether
  the target acted, and wrote the target's state before the target did anything
  (which also kept a vanished device looking active for 90 s).
- "Play on device" ended the receiver's DJ session, while a local tap during DJ
  mode starts a DJ selection: remote and local behaved differently.
- `playback_start_requested` meant resume, play one song, or restore a
  transferred session, decided by heuristics on both platforms.
- No device state reached other devices; controllers polled `/api/devices`,
  which did not say what was playing.
- Two tabs of one browser shared a `device_id`: both executed every command, and
  closing the last-registered one marked the device offline while the other
  still played.
- Every browser registered as `desktop` (the engine rewrote `web`), and every
  browser was named "Soundsible Web" by default.
- Transfer stopped the source before knowing whether the target started.
- The command path existed three times: remote-command, handoff and the agent
  API.

## Decisions

| Decision | Choice |
| --- | --- |
| Who owns playback | The playing device. The engine relays and copies state; it keeps no queue (see architecture review point 4). |
| Library, Search and Discover while controlling another device | They act on the controlled device, as player controls do. "This device" is one tap away in the device sheet. |
| Android apps older than the engine | Listed as needing an update. The two old endpoints stay one release as wrappers. |
| Volume | `transport.set_volume` for web targets; Android does not declare it yet. |
| Native iOS | Out of scope: never installed. The PWA is the iPhone client. |

## Status

| Item | Status |
| --- | --- |
| Engine: registry, instances, dispatcher, live state events, transfer, wrappers, agent API | open |
| Web target: executor, instances, names and form factor, `live`, prompt session publishing | done |
| Android target: executor, transfer, existing callers on the new endpoints | open |
| Web player read through one accessor (no visible change) | done — `ui_web/src/stores/player.ts`; `stores/identity.ts` still reads local playback (import cycle), fixed with connected mode |
| Web connected mode: device sheet, controlling another device, states and messages | open |
| Android app connected mode | open |
| Remove `/api/playback/remote-command` and `/api/playback/handoff` wrappers | open — the release after this ships |
