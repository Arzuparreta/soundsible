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
