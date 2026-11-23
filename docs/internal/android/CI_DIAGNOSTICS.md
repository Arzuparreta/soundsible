# Android shard diagnostics

The artifact `soundsible-android-emulator-<shard>-<sha>` contains JUnit,
per-case logcat in `app/build/outputs/androidTest-results/`, `build/fixture.log`
and `build/emulator.log`. The latter is captured continuously from before
the tests: it keeps the initial cases even if the emulator's circular buffer
has been overwritten at the end. The original exit code is
kept; cases are not retried or skipped automatically.

## ADB startup and fixture network

In PR #426, run `42362004721`, shards 2 and 5 ended before
installing or running the app: after `boot_completed`, ADB temporarily went back
to `device offline` when running `svc wifi enable` (exit codes 255 and 1).
`scripts/android.py` pins the validated serial and gives that preparation command
a total budget of 30 seconds, with each process limited to five.
Only transient transport/service failures are retried; permission errors
fail immediately. The last diagnostic is kept, including
an exit 255 without text. Instrumentation cases are not retried. Exhausting the
budget is still a CI failure, not a skip or a simulated success.

PRs #432 and #433 exposed another point before Wi-Fi is enabled: the
query of `ro.kernel.qemu` could return `error: closed` (exit 1) or an
exit 255 without text after boot. The app had not been installed and the
instrumentation had not started. Verification of the selected serial now has a
budget of 30 seconds for those disconnections, with each query limited
to five seconds. A successful response that is not `1`, missing authorization
or a permission error is rejected immediately. It is used both in integration
and in the release APK acceptance; no test is retried.

## Silence in Live after recovering WHEP

Search for `LiveTestDiagnostics` in the logcat of `LiveListenerTest` or of the shard.
The JSON observations include monotonic time, phases, Activity closure,
MediaSession state, generated/decoded/audible PCM and age of the
last audible block. The periodic samples are also taken during the
`await` calls, before the `finally` closes the peers.

- `peer.start`, `peer.state`, `ice.state`, `peer.cancel`, `peer.close`: each
  peer has a local identifier and `publishing` distinguishes sender and receiver.
- `listener.gain`, `listener.focus`, `track.bound`, `track.volume`: relate
  playback request, focus, ducking, volume and applied gain.
- `rtc.stats`: packets/bytes, losses, jitter, audio energy, samples
  concealed by the decoder and latency of the selected ICE pair.
- `relay.stats`: incoming/outgoing RTP counters per publisher/reader of the
  real relay, limited to the room of this test.

Compare **increments** between samples. If the synthetic source advances but the
sender's packets do not, investigate capture/encoding. If the sender
sends but the relay does not receive, investigate the transport to the relay. If the
relay receives but does not deliver to the reader, investigate the relay. If RTP arrives
at the receiver and `concealedSamples`/`silentConcealedSamples` grow, investigate
losses, jitter and decoding; PCM callbacks with zero RMS do not prove
that audio packets have arrived. If the counters and the energy are
normal, compare the applied gain and the focus with the exact phase.

## RTP stopped with ICE connected

The tag gate of PR #433 recorded eight RTP packets at the receiver during
twenty seconds, with ICE connected, active STUN queries and
concealment/silence callbacks. The relay was still processing media; that counter does not prove
datagram delivery. It was not demonstrated that closing the Activity caused the loss.
The fixture reset timeout happened in the first case, several minutes earlier,
and is kept as a separate incident, without attributing a common cause to it.

The listener now observes RTP progress while playback is requested without
focus ducking. It gives ten seconds at the start and recovers after five seconds without
progress after receiving media. It does not use PCM amplitude: legitimate silence
remains healthy if packets arrive. It reuses the bounded reconnection budget;
a connected ICE no longer resets it until five seconds of sustained progress are
observed. Pause/ducking rearm the grace period and do not query statistics.
If the same transport reconnects during the backoff, only the pending restart
is cancelled: the budget and its original deadline stay active until
sustained media is confirmed. The Codex review detected this case and it is covered with
simulated-clock regressions for cancellation, deadline and preserved backoff.

The native regression stops the RTP encodings of the synthetic sender, keeps
ICE and room sockets, requires BUFFERING and checks automatic recovery of
RTP/audio while keeping volume, playback intent and room identity.
It also requires real packets after closing the Activity: concealment
alone can no longer satisfy that guard. This repairs the lack of recovery
from stopped media; it does not identify the original cause of the datagram loss.

The observation is enabled only when the instrumentation installs its observer.
It does not export PCM, SDP, URLs, tokens, cookies, ICE candidates or IP addresses.
`sample.failed`/`rtc.stats.unavailable` indicate a diagnostic gap, never
permission to consider the test passed.

## Incident of 2026-11-03

Run `41548539741`, initial attempt, main `9986f87b`: only shard 6 failed,
`LiveListenerTest.tlsCoreRelay`, with `Activity close stopped remote programme`.
At the time of failure: READY, playback requested/active, volume 0.4, 2794 PCM
callbacks, 129 audible, 3055 reads from the synthetic source and zero RMS. The relay
kept publisher and reader until cleanup. Without RTP, energy or a gain
timeline, that silence cannot be attributed to the Activity closure and it cannot be decided
whether the origin was the application, the relay or the emulator. A passing retry demonstrates
intermittency, not a resolved cause. The assertions are not relaxed.

## Remote handoff diagnostics

PR #473, run `44077652665`, shard 6 failed `DevicesUiTest.tlsDevices` after
waiting for a handoff event, then dereferencing the absent payload. The emulator
log shows the test seeking at 11:58:21.287, buffering, and returning to PLAYING
at 11:58:21.476. The test clicked transfer immediately after issuing seek,
repeat and shuffle commands. Native handoff deliberately rejects a source whose
transport/session changes during its HTTP requests, so this setup could race
that guard. The test now waits for the service's Core publication to confirm
playing at the requested position with the intended queue index, repeat and
shuffle before clicking transfer. The peer-delivery, queue, position and native
stop assertions remain intact; a missing event reports the devices panel instead
of a null-pointer exception. Remote emulator validation remains required.

In PR #434, run `42567024132`, shard 7 ran 33 cases and failed
`QueueLanesTest.httpQueueLanesAndResume`: the laptop received the stop command,
but the phone's native snapshot still had an empty queue after accepting
Resume. This is different from shards 1 and 5, which did not reach instrumentation
because the MediaMTX download exhausted six HTTP 504 attempts.

Shard 3 of the next head failed in the same download before instrumenting.
The six attempts now alternate between the download URL and the official API for the same
immutable GitHub asset, with `Accept: application/octet-stream`. Both paths
require the same SHA-256 and size limit. A real download through
the API was verified against the pinned hash; receiving JSON or different bytes still fails.

A successful handoff HTTP response does not confirm that the phone has applied the command.
The traces must distinguish socket registration, delivery to the client, rejection by
owner/generation and an exception when rebuilding the queue. The case's assertions
and deadlines are kept; a green retry alone does not demonstrate
that the cause has been repaired.

## Device websocket reset after a command on the TLS fixture

On `feat/remote-control` (`38beec30`) and `remote/android-fixes`, shard 2 failed
`DeviceSessionTest.tlsDeviceSession` and usually `DeviceDjSessionTest.tlsDjDevice`
in every run (`45041273974`, `45045473052`, `45064901488`, `45066770176`,
`45068411496`, `45069933938`, `45071615842`, `45073425251`): a command answered
`503 {"reason":"offline"}` right after `transport.seek` or `transport.next`.
The HTTP variants never failed.

Temporary fixture logging (socket registrations, engine.io closes, websocket
read errors with client port and file descriptor, stream requests) showed the
same sequence in every failure:

1. the engine sends `device_command` (seek or next) to the device websocket;
2. the app opens the new audio stream and closes the previous audio TLS
   connection (`request_end` of the old `/api/static/stream/…`);
3. the app's acknowledgement arrives on the device websocket;
4. within 7–65 ms the server's read on that same websocket connection (same
   client port and descriptor) fails with `ConnectionResetError(104)`, so the
   engine drops the instance and answers `offline`.

The app's Socket.IO client logs no transport error or disconnect for that
socket: from its side the websocket is still connected. Engine bookkeeping is
not involved (a later disconnect of an older socket never removes a newer
registration of the same instance). Per run, the TLS fixture logged 4–7 such
resets and the HTTP fixture none. Removing the engine's `device_updated`
broadcasts did not change the result (run `45073425251`). The same fixture
logging on `main`'s code (run `45075373452`, temporarily on this branch) showed
three resets in the whole shard, none after an audio stream ended: on `main` the
device never writes on its websocket while it carries out a command, because
the old events had no acknowledgement. On the host, a Python client that
aborts audio TLS streams while acknowledging commands kept its websocket for
150 commands, so the server's TLS stack alone does not reproduce it.

Open: whether the reset comes from the emulator's network or from the app's
TLS stack has not been established, and no fix is merged. Options under
consideration: a TLS terminator in front of the plain fixture (the production
engine serves plain HTTP behind a proxy), a client-side liveness check on the
device socket, or a different transport for it.

## Publisher closed after 30 s in the Android Live fixture

On `main` (`e6bad843`, run `44857843679`, shard 5), `LiveListenerTest.httpCoreRelay`
failed at `Manual retry did not recover decoded Live` with `state=1, requested=false`.
The failure was unrelated to PR #483 (`StartupTest` passed).

The shard artifacts showed MediaMTX closing the synthetic publisher (`peer:1`,
session `1e7ec0df`) with `closed: peer connection closed` 30.4 s after connecting
(`02:56:20` to `02:56:51`), while MediaMTX was still receiving 50 RTP packets/s.
Comparing `rtc.stats` against passing runs showed `peer:1`'s `candidate-pair`
`packetsReceived` froze at `3` after the first second (versus `+11 packets/s` of
RTCP/TWCC in passing runs), so MediaMTX's `pion/ice` keepalives on its selected
pair received no responses and hit `5 s disconnected + 25 s failed = 30 s`.
Once the publisher closed, every WHEP manual retry failed with 404 (`no stream
is available`).

`scripts/android_live_fixture.py` left `webrtcIPsFromInterfaces` at its default
(`true`) and bound `:28189` on all interfaces, so MediaMTX advertised host
interface IPs (`10.1.0.x`, `172.17.0.1`, `127.0.0.1`) alongside `10.0.2.2`.
Behind QEMU SLIRP's UDP NAT, MediaMTX could pair `local: host/udp/127.0.0.1/28189`
with a non-loopback `remote: prflx/udp/10.1.0.120:<port>` whose return packets
were dropped. The fixture now binds MediaMTX WebRTC listeners to `127.0.0.1`
only, sets `webrtcIPsFromInterfaces: false`, and advertises only `10.0.2.2`.
