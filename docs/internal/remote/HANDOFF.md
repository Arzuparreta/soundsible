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
| Engine: registry, instances, dispatcher, live state events, transfer, wrappers, agent API | done — `shared/remote/` (registry, validator, dispatcher), instances, `rev`/`seq`/`live` in `shared/playback_state.py`, `watch_device`/`device_updated`/`device_state`, `/api/devices/<id>/commands`, `/api/devices/transfer`, wrappers and agent API on the dispatcher |
| Web target: executor, instances, names and form factor, `live`, prompt session publishing | done — `ui_web/src/stores/remoteCommands.ts`, `lib/deviceIdentity.ts`, publishing in `stores/session.ts` |
| Android target: executor, transfer, existing callers on the new endpoints | done — `RemoteCommandLogic.kt` (also the per-command guards), executor in `PlaybackService.kt`, transfer in `NativeDeviceSession.kt`; not declared: `transport.set_volume` (system volume), `dj.promote`, `dj.avoid` (no native handler). Open: on the TLS emulator fixture the device websocket is reset right after a seek/next acknowledgement, so `DeviceSessionTest.tlsDeviceSession` and `DeviceDjSessionTest.tlsDjDevice` fail (evidence in `docs/internal/android/CI_DIAGNOSTICS.md`) |
| Web player read through one accessor (no visible change) | done — `ui_web/src/stores/player.ts`; `stores/identity.ts` still reads local playback (import cycle), fixed with connected mode |
| Web connected mode: device sheet, controlling another device, states and messages | done — `stores/remote.ts` (devices, target, watched state, projection, commands, transfer; loaded with the socket, outside the initial bundle), `stores/remoteLink.ts` (what `player()` and `stores/identity.ts` read), `stores/player.ts`, `components/ConnectSheet.tsx` (replaces the Settings → Devices transport panel), `OmniBar`, `PlayerSurface`, `PlayerStage`, `ResumeBanner`, keyboard shortcuts, `transport.set_muted`; target side: session and live tracked apart in `stores/session.ts`. The reported DJ `queue.move` publication lag did not reproduce: the applied publication carries the moved route (regression test in `stores/remoteCommands.test.ts`) |
| Android app connected mode | done — the controller logic of `stores/remote.ts` moved to `lib/remoteControl.ts` (one implementation, the device and the watch link injected); `NativeDeviceSession.kt` forwards `device_updated`/`device_state` to the WebView and answers `deviceWatch` (`PlaybackPlugin.kt`), watching again after a reconnect; `lib/program/remoteTransport.ts` gives the Android player surfaces a `ProgramState` of the controlled device and sends their `ProgramCommand`s as contract commands (`ProgramState.controls` hides what the device does not declare; stop, autoplay and the radio profile have no command); `mobile/remote.ts`, the Devices button and `components/ConnectSheet.tsx` (shared with the web) in `mobile/AndroidStart.tsx`; Settings → Devices keeps the name and pairing. Not covered by an instrumented test: the re-watch after the service's own socket reconnects |
| Remove `/api/playback/remote-command` and `/api/playback/handoff` wrappers | open — the release after this ships |
