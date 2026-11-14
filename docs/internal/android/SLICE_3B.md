# S3b: native DJ execution

End-to-end integration in sources: the `dj` command of SoundsiblePlayback requests
Core `/api/discovery/music/dj-plan` without stopping the programme during the request;
temporary retry bounded to 60s and scope per account/occurrence. ProgramDjSession
executes route/cues over ProgramMixOutput, the logical Player keeps MediaSession,
a single focus/noisy and the NativeProgramOutput tap post-DSP/pre-volume. The menu offers
From current. Native/test/JVM48/lint pass in
/tmp/soundsible-s3b-dj-e2e-foundation.log. Real HTTP/TLS DjProgramTest still
pending; do not declare DJ delivered. Direction/refill/extended editing,
phase correction and production OS/recovery contracts require further work.
From current re-prepares the input with the current position; this integration
does not demonstrate acoustic continuity when switching from NORMAL to DJ.
First end-to-end HTTP/TLS2 fails while reading the pause test: StartupTest
returns JSON.stringify as an encoded JSON string; JSONObject rejected it.
Both reach real Core, PCM mixing in background and incoming dominance before
the failure. Log /tmp/soundsible-s3b-dj-e2e-native.log, prepare on 71ab534b dirty
(sources equivalent to block f12f39fc). Position reading in JS, cleanup in finally
and neutral initial direction are corrected. Repeat the full run on a
clean commit; do not accept this first partial execution.
Second end-to-end on clean 869b9018: HTTP/TLS2 fails after validating pause,
when using awaitReady from StartupTest after recreating an already authenticated Activity. That
helper requires the unconfigured connection screen; the app showed the library and
the preserved DJ programme. Log /tmp/soundsible-s3b-dj-clean-native.log. The test now waits for
the library without data-booting on recreation. Run the full NORMAL return again.
Third on 19c1e216: HTTP completes the run, TLS fails at stop. Targeted TLS
diagnosis on 1399be65 confirms NetworkOnMainThreadException in
PlaybackService.closeProgram: evictAll closed SSL on the main thread. Logs
/tmp/soundsible-s3b-dj-recreation-native.log and
/tmp/soundsible-s3b-dj-close-diagnostic-native.log. Audio transport receives its
own pool/dispatcher and TLS cleanup on a worker; shutdown releases its executor.
The test also cleans original R128 facts and transforms rejection into a boolean
to avoid waiting 45s when there is already an error. Repeat DJ and NORMAL regression.

## Service integration in progress

PlaybackService uses ProgramPlayerRouter (ForwardingSimpleBasePlayer) over
the existing NORMAL ExoPlayer. The session, programme listeners and helpers receive
the same facade. Replacing the backend requires the previous one stopped/idle and the next one
without requested play; the caller keeps responsibility for releasing the retired one.
The DJ backend is not connected yet. Native/test compilation, JVM48 and lint
pass in /tmp/soundsible-s3b-router-tests-foundation.log; targeted APK tests and
full service regression pending. Do not replace the S3a78 evidence.
First targeted APK run: 2 tests/1 failure in
/tmp/soundsible-s3b-router-native.log. The forwarding fixture created a MediaItem
without URI, which DefaultMediaSourceFactory rejects even without prepare. A URI
of a synthetic asset is added, without prepare or reading, keeping the events and
controls test; repeat before accepting. First attempt without emulator did not run tests.

## Starting point

S3a delivers levelling and PCM output of one Media3 stream: see [evidence/s3a.json](evidence/s3a.json).
It does not deliver overlap, DJ techniques or Live broadcasting. The current NORMAL plans
use the native service and its runway; do not confuse Radio with a DJ session.

## Contract that the next block must implement

Read `ui_web/src/stores/dj.ts`, `lib/generatedQueue.ts`,
`lib/audio/contracts.ts`, `lib/audio/mixer.ts` and `lib/audio/graph.ts`.
The planner selects and describes transitions; the service executes cues,
preroll, rate, phase correction, pause and cancellation even when Solid is suspended.
The techniques are direct, safe_fade, structural_fade, bass_swap, filter_blend,
long_blend and echo_cut. The name of a technique or a Core switch does not prove an effect.

The output still has one owner and one MediaSession. Two decoders
can be inputs of a mix, but not two independent audible outputs.
Both inputs use private native sources, bounded preparation/retries and
distinct occurrences; do not expose cookies or open HTML audio in parallel.
The final stream requires per-input levelling, EQ/filter/echo, mixing and limiter,
with a post-DSP/pre-volume tap. Keep NORMAL/offline/podcasts and focus/noisy.

Before choosing an implementation, resolve in an executable spike:

1. Decode two real sources and align samples with an output clock;
   check backpressure, format changes, pause, seek and end of the outgoing track.
2. Keep output continuous when dominance and metadata change. Do not release and
   recreate the audible owner on each route edit or restart the incoming track.
3. Edit/replan only uncommitted segments. Occurrence keys, programToken,
   current direction and fromKey govern receipts/cancellation; an incoming failure
   leaves the outgoing track audible and keeps explicit recovery.
4. Measure both frequencies during equal-power and check techniques/limiter on
   PCM, OS control, background and account scope. Then integrate UI/planner.

The current CompositionPlayer rebuilds holders when replacing compositions; its
AudioGraph/PlaybackAudioGraphWrapper classes are package-private. S3a documents
the verified official APIs. Do not assume that a static composition accepts
a dynamic route or patch generated libraries to simulate a public API.
The public AudioMixer alone does not solve ownership, clock and controls either.

## Later acceptance

Contextual/new session, direction, sources, requests, reorder/repair, temporary
retries without cutting the current track, manual Next, pause/seek, Activity/background,
cancellation and private output. Inventory current actions before declaring
parity. Live listening/broadcasting with an independent listener and Auto/DHU come
later; signing/update and full gates remain mandatory for alpha.

This document is continuation context, not evidence of implemented DJ.

## Spike prepared during the S3a regression

The APIs of the real tag of the dependency were verified:
[AudioOutputProvider](https://github.com/androidx/media/blob/1.11.1/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/audio/AudioOutputProvider.java),
[AudioOutput](https://github.com/androidx/media/blob/1.11.1/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/audio/AudioOutput.java)
and their public forwarding classes. DefaultAudioSink converts/processes before requesting
the output. This allows testing inputs without their own AudioTrack and with a common owner;
it does not yet demonstrate dynamic dominance or integration with the service.

The clean S3a principal run 78+restart2 is accepted; spike sources already integrated:
ProgramMixCurve, ProgramDeckEffects, ProgramMixLimiter and ProgramMixOutput, with
their JVM tests and isolated instrumented ProgramMixOutputTest. Native/test
Kotlin compile; JVM36/0 and lint pass in /tmp/soundsible-s3b-mix-foundation-fixed.log.
The first compilation failed only because of old Java OkHttp calls in Kotlin;
corrected by using the installed extensions. Real AudioTrack has not been tested yet.

Each decoder normalizes mono/stereo channels with a constant-gain matrix and Sonic 48k
before entering the common output. The fixture accepts secondFrequency880,
secondRate48000 and secondChannels2 with strict values; the S3a tests keep
440/16000/mono. The test measures 440/880 amplitudes in PCM and checks independent local
volume and releasing the outgoing decoder without recreating the audible owner.

Filters use normative [Web Audio](https://www.w3.org/TR/webaudio-1.0/#filters-characteristics) coefficients:
the lowpass Q=0.7 is in dB, it is not linear quality. The resonance test at
cutoff distinguishes both formulas. EQ/lowpass/echo/limiter are in the spike, still
without acoustic acceptance or exact equivalence to the browser DynamicsCompressor.

Do not declare the graph functional based on unit curves or a single crossfade: missing are
a real HTTP/TLS test, EOS/backpressure, scope, pause/seek and dominance on the playout
clock. The master reserves the frames of the current buffer before allowing a
new blend; do not schedule over samples already committed. Changing metadata when
a future buffer is computed would confuse the listener. Then integrate controls/queues
and the DJ planner and revalidate the previous NORMAL flows. Continue until the
full gates; leave the PR open with passing checks for manual review, without automerge.

First AudioTrack HTTP/TLS fails 2: shared provider accessed from two ExoPlayer
loopers and cleanup from instrumentation without a Looper. Log
/tmp/soundsible-s3b-mix-native-jdk21.log. It does not replace the green S3a78 principal run.
The owner now provides a common decoding HandlerThread, both ExoPlayers
use it and the release of AudioTrack/provider is scheduled there, waiting for onReleased
before closing the thread. Kotlin/test/JVM36/lint pass in
/tmp/soundsible-s3b-mix-looper-foundation.log; repeat real AudioTrack before
accepting it. The initial rejection of the system JDK is kept as a diagnostic in
/tmp/soundsible-s3b-mix-native.log, with no instrumentation executed.

Second real run accepted: HTTP/TLS2/0/0/0 on clean prepare 16ed5d83,
log /tmp/soundsible-s3b-mix-looper-native.log. Both different formats are
normalized; 440/880 amplitudes measured during equal-power; local volume 0.1 does not
change the tap and releasing the outgoing track keeps the incoming one. APK/test APK/JVM36/lint
normal runs after removing the CA pass. See evidence/s3b.json. It is still an
isolated spike: continue pause/seek/EOS/starvation/scope and techniques, then the
Player/MediaSession facade and planner; do not describe production DJ as delivered.

Extension in sources: serialized device access (write/control/clock/
release), pause/resume with physical clock and revocation by real clearSession,
not a UI flag. Fixture cleanup happens before deleting the session; no
audio request remains authorized afterwards. Native/test compilation, JVM36 and lint
pass in /tmp/soundsible-s3b-mix-pause-foundation-fixed.log. The first compile of
these assertions failed by using Long with the JUnit Double overload; corrected to a
bounded comparison of microseconds. Extended HTTP/TLS acceptance pending.

Pause/scope extension accepted HTTP/TLS2/0 in
/tmp/soundsible-s3b-mix-pause-native.log on clean 4b6489ee: physical clock stopped
on pause, resume, real clearSession invalidates/pauses/flushes; normal build without CA
APK/test APK/JVM36/lint passes. Next: seek with a synthetic audible marker at 1320Hz
after 4s to distinguish samples before the jump; still without acceptance.

Seek in sources: epoch invalidates reserved buffers and flushes AudioTrack when
resetting the active deck; the standby keeps its prebuffer and a frozen clock. Serialized
writing revalidates the epoch inside the device lock. The optional fixture
firstMarker generates 440Hz before 4s and 1320Hz after; R128 facts are measured on the
real file. The seek10s test requires a new epoch and the 1320 marker in PCM, a restarted physical
clock, and keeps the later blend. Compilation/test/JVM36/lint and Ruff
pass in /tmp/soundsible-s3b-mix-seek-foundation.log; extended Native pending.

First Native seek HTTP/TLS2 fails because Media3 replaces/releases the input,
without calling the wrapper's flush. Log /tmp/soundsible-s3b-mix-seek-native.log; do not
accept seek or replace the previous pause result. The correction invalidates the
physical buffer and the epoch also when releasing/replacing the active input,
idempotently; releasing the already inactive outgoing input still keeps the master.
Kotlin/test/JVM36/lint pass in
/tmp/soundsible-s3b-mix-seek-replacement-foundation.log. Repeat the real marker.

Repeated seek accepted HTTP/TLS2/0 on clean 6d0626a0, log
/tmp/soundsible-s3b-mix-seek-replacement-native.log; new epoch, PCM 1320 after
seek10s, master clock restarted and later blend coherent. Pause/revocation
still pass; normal APK/test APK/JVM36/lint without CA pass. It does not prove acoustics
or MediaSession integration; next: physical dominance and incoming recovery.

Playout window in sources: ProgramMixWindow keeps start/length/decks/epoch
to resolve dominance with the physical position, independent of early promotion
by the render. Invalidate removes the window. DIRECT changes input without consuming incoming
frames during a false overlap; volume/single AudioTrack are kept. The Native
test extends to four HTTP/TLS fade/direct cases: dominance 25%/75% and the direct
entry cue without a jump. Native/test/JVM38/lint compilation pass in
/tmp/soundsible-s3b-mix-direct-foundation.log; extended real test pending.

Dominance/direct accepted HTTP/TLS4/0 on clean 5f762ba1, log
/tmp/soundsible-s3b-mix-direct-native.log. Metadata follows the physical clock 25/75%,
DIRECT does not consume the incoming cue as overlap, seek/pause/scope still pass.
Normal APK/test APK/JVM38/lint after removing the CA pass. Next: incoming
drop during blend without cutting the outgoing track, EOS/techniques, then facade/planner.

Recovery in sources: releasing a committed incoming input during blend keeps
AudioTrack and already valid buffers, returns to the retained outgoing input with a 150ms ramp of
gain/EQ/filter/echo, releases the limiter gradually and schedules restored dominance
at the frame that will reach the device. Do not empty the programme on a standby failure.
The test extended to six cases includes real disappearance of the incoming ExoPlayer HTTP/
TLS, PCM of the outgoing input and pause/scope afterwards. Kotlin/test/JVM38/lint pass in
/tmp/soundsible-s3b-mix-recovery-foundation-fixed.log; the first compile of the new
predicate failed because of a JUnit trailing lambda, corrected to an explicit variable.
Native6 pending. Before production add piecewise clock mapping to
resume a deck after a gap without changing its position before playout.

Incoming recovery accepted HTTP/TLS6/0 on clean f001e95a, log
/tmp/soundsible-s3b-mix-recovery-native.log. The incoming decoder is released during
fade; the tap confirms the outgoing input restored and dominance on playout; seek/pause/
scope and normal APK/test APK/JVM38/lint pass. Not equivalent to a live network/provider or
late recovery after a gap; next: piecewise clock mapping and Native8.

Piecewise clock in sources: ProgramDeckClock maps reservations to frames actually
played from each deck, freezes position during gaps and does not move the
previous clock when reserving a future return. Contiguous spans are coalesced; history
maximum 64, pruned only after reaching the next physical segment; reset discards
the previous epoch. Source.getPositionUs uses that mapping, it does not readjust joinedAt on
recovery. Kotlin/test/JVM41/lint pass in
/tmp/soundsible-s3b-mix-clock-foundation.log. Native extends to eight cases with a late
drop at 95% and a check that the outgoing clock does not move backwards; acceptance pending.

First clock Native8 fails 2 only on the late drop: releasing the deck that already controls
render pauses AudioTrack; recovering the old Source did not resume the device. Log
/tmp/soundsible-s3b-mix-clock-native.log; the accepted principal run of the spike is still 6.
The correction resumes the retained master if there is no desired pause, the session is still owned
and there is no fatal error; the callback of a released input does not pause or flush the replacement.
Kotlin/test/JVM41/lint pass in /tmp/soundsible-s3b-mix-clock-resume-foundation.log.
Repeat Native8 pending; do not claim late acceptance or real clock mapping yet.

Clock/late recovery accepted HTTP/TLS8/0 on clean ca242c26, log
/tmp/soundsible-s3b-mix-clock-resume-native.log. The incoming resource is lost at 95%,
the outgoing clock does not move backwards, the master resumes and PCM/dominance return to the retained input.
Normal APK/test APK/JVM41/lint without CA passes. Do not claim service integration,
planner, remaining techniques or EOS yet. Continue Native FX and then facade/planner.

Native FX in tests (pending): the optional fixture firstFrequency80/100 generates a
real 20s file with measured R128 facts; previous defaults intact. Bass swap
measures 80Hz attenuation with an incoming 4400Hz; filter/long check the filtered input
before the midpoint and long combines bass swap; echo uses 100Hz (28 cycles/280ms) and
a distinguishable return at the end; structural_fade uses equal-power. The class extends to 18
HTTP/TLS cases of seven techniques and recovery. Kotlin/test/JVM41/lint and Ruff
pass in /tmp/soundsible-s3b-mix-fx-foundation.log. No tempo/phase correction,
EOS or planner/MediaSession integration accepted; do not equate names with parity.

First Native18 fails 1 (tlsStructuralFade): the first outgoing block arrives before
the incoming PCM, blend rejected an input that was not ready. The remaining 17 without failures, but the class is
not accepted; log /tmp/soundsible-s3b-mix-fx-native.log. The readyInput API checks
ownership/generation, absence of fatal error, playing and 50ms of PCM. The crossfade requires that
condition; the test uses a bounded 5s wait on real data while the outgoing input continues.
Kotlin/test/JVM41/lint pass in /tmp/soundsible-s3b-mix-fx-ready-foundation.log;
repeat class 18 before accepting techniques.

Class Native18 accepted on clean e0499c4e, log
/tmp/soundsible-s3b-mix-fx-ready-native.log: seven HTTP/TLS techniques with real
spectra, readiness and clock/seek/recovery/pause/scope. Normal APK/test APK/JVM41/lint
without CA passes. Do not confuse equal-power structural_fade with the tempo/cues/phase of the
planner, not yet connected. Next: real WAV+FLAC, EOS and native timed execution.

FLAC in fixture/test: optional secondFormat wav/flac encodes the synthetic tone
with ffmpeg, removes the WAV and records format/size/facts of the real compressed file.
Defaults intact. Tests httpFlacMix/tlsFlacMix use the same graph with WAV mono 16k and
FLAC stereo 48k, mid/final PCM, seek/clock/pause/scope. Kotlin/test/JVM41/lint and
Ruff pass in /tmp/soundsible-s3b-mix-codec-foundation.log. Targeted Native codec 2
pending; the extended class 20 does not replace 18 until it is repeated if required.

Targeted codec 2/0 accepted on clean f5178e54, log
/tmp/soundsible-s3b-mix-codec-native.log: WAV mono 16k + FLAC stereo 48k over HTTP/
TLS, two normalized decoders, PCM mix/seek/clock/pause/scope and normal APK/test/
JVM41/lint pass without CA. Targeted result separate from the 18 of the previous class.
Next: EOS with a prepared incoming input, tempo/phase, Player facade and planner.
The installed ForwardingSimpleBasePlayer API allows a protected setPlayer: candidate
for a MediaSession router that preserves NORMAL behaviour; verify and
test before integrating, do not rebuild previous controls by assumption.

EOS in sources/test: drainedInput requires ended, an empty queue and all reserved
frames reached by the hardware. DIRECT resumes its own master if there is no
desired pause/fatal error, to take over from a renderer that Media3 paused when it ended.
httpEndOfSource/tlsEndOfSource seek to 19.5s of the 20s file, wait for real drain and
STATE_ENDED, and cut to an already prepared input without consuming its cue. Kotlin/test/
JVM41/lint pass in /tmp/soundsible-s3b-mix-eos-foundation.log; Native EOS2 pending.

Initial EOS HTTP/TLS2 fails: the last PCM does not reach the physical clock before the
decoder pause. Targeted HTTP1 diagnosis on 078e94fa: ended=true, queued=0,
supplied=24000, played=19632, playing=false. Logs
/tmp/soundsible-s3b-mix-eos-native.log and
/tmp/soundsible-s3b-eos-diagnostic-native.log. Do not accept EOS yet.
The owner ignores the ended-state pause of the decoder and allows its queue to drain;
an explicit programme pause is still effective. Kotlin Native/test,
JVM41 and lint pass in /tmp/soundsible-s3b-eos-tail-foundation.log. HTTP/TLS
repetition pending; it does not replace previous techniques/FLAC evidence.

Repetition with a separate ended pause still fails HTTP/TLS2: played 19633 of
24000 even with playing=true, log /tmp/soundsible-s3b-eos-tail-native.log. The
latency-compensated AudioTrack clock freezes on underrun without new writes.
The next correction writes silence only until the real frames are drained;
it does not count that silence in the deck's media clock and does not call AudioOutput.stop
(that output does not resume PCM after stop without flush). EOS is still pending a test.

EOS accepted HTTP/TLS2/0 on clean f180e8ea, log
/tmp/soundsible-s3b-eos-silence-native.log: real PCM of 24000 frames drained before
STATE_ENDED, DIRECT takeover to a prepared cue, pause/scope preserved. Normal
APK/test APK/JVM41/lint without CA passes. Next: tempo/phase and then service/planner.

Tempo accepted HTTP/TLS2/0 on clean b2e208b8: PCM 1600Hz keeps pitch with
speed 1.05, the Exo media clock corresponds to output frames adjusted for
speed. Seek/blend/pause/scope are preserved; normal APK/test APK/JVM41/lint
passes. Log /tmp/soundsible-s3b-tempo-native.log. It does not yet test cues/phase or
progressive rate return after the blend; production DJ is still pending.

Cue/preroll accepted HTTP/TLS2/0 on clean e7e36547, log
/tmp/soundsible-s3b-cue-native.log. Arm is scheduled against the reserved output, splits
buffers at preroll/cue/end boundaries; consumes 500ms of incoming audio in silence,
the common clock aligns the input and metadata follows playout during overlap. Earlier PCM
does not contain the incoming tone. Normal APK/test APK/JVM41/lint passes. It does not yet test
an absolute Core plan, correction/cancellation or the DJ service; next: edit the future.

Cancellation in sources: only before reserving overlap PCM; never confuse
audible preroll that is still silent with an uncommitted mix. First test
HTTP/TLS2 fails because it attempted cancellation 250ms before the physical cue but the
render had already reserved the mix; the guard correctly rejects it. Log
/tmp/soundsible-s3b-cancel-native.log. Adjust the test to preroll 2s/margin 1.75s,
keep rejection after a committed blend. The correction does not weaken the guard.

Cancellation/standby seek accepted HTTP/TLS2/0 on clean 53717d2f, log
/tmp/soundsible-s3b-cancel-reservation-native.log. Cancelling the future keeps
PCM 1320 and epoch, seeking the standby restarts only its clock, a new arm mixes and
rejection of a committed cancellation passes. Normal APK/test APK/JVM41/lint passes.
It does not yet integrate controller/planner; next: rate return and Player facade.

Rate return accepted HTTP/TLS2/0 on clean 5b5dbed8, log
/tmp/soundsible-s3b-rate-return-native.log. ProgramRateReturn returns 1.05→1 in 8s
of playout, not wall time; pause holds the ramp, progress is monotonic and scope/epoch
cancels the callback. PCM 1600Hz keeps pitch; normal APK/test APK/JVM41/lint passes.
The helper is still in an isolated spike, it does not enable DJ in production. Next: per-input
levels and Player/MediaSession/planner facade.

Full spike regression accepted 32/0 on clean f2e7a921: seven techniques,
WAV/FLAC/EOS, tempo/return, preroll/cancel/standby seek, early/late loss,
pause/scope and per-input levels. Source levels 0.5/0.75 are observed in PCM and
changing the incoming input to 0.5 uses a 10ms envelope independent of local volume. Order
the same as graph.ts: EQ/filter→level→dry and echo→master/limiter. Log
/tmp/soundsible-s3b-complete-spike-native.log, normal APK/test APK/JVM41/lint passes.
The S3a78 principal run has not been repeated with the spike; do not integrate DJ or alpha yet.

Difference found with Core: shared/dj_engine.py allows overlap 48s; the spike
accepted so far limits it to 30s. Extend to a 60s range and test a full LongBlend48s
with a 90s outgoing source, plus a conservative/fromKey policy before the Player facade.

Core48s extension and ProgramDjPlan compile; seven tests of fromKey policy,
fallback, cue, tempo/phase limits and disabled mixing pass (JVM48 total),
Ruff/lint pass. First LongBlend48s HTTP/TLS2 fails after the measured mix:
the test releases the outgoing input when it observes almost silent PCM before the full end,
because the low-shelf attenuates its 80Hz. Stack run:297 in
/tmp/soundsible-s3b-full-long-native.log. Wait for the physical end of the 48s window before
releasing the outgoing input; keep the PCM thresholds and repeat. Do not accept 48s yet.

LongBlend48s accepted HTTP/TLS2/0 on clean bbfcd056, log
/tmp/soundsible-s3b-long-end-native.log: PCM 80/4400 at 25/75%, physical dominance,
full 48s window before releasing the outgoing input and continuation of the incoming one.
Normal APK/test APK/JVM48/lint passes. The Core overlap is not trimmed to the old 30s.
Next: outgoing drop and then Player facade/service/planner; production DJ
is still pending.

Loss of either input accepted HTTP/TLS8/0 on clean b210eeb3,
log /tmp/soundsible-s3b-outgoing-loss-native.log. If the outgoing input drops during
blend, the healthy incoming input continues with EQ/dry restored in 150ms; no flush/new epoch,
clock and metadata follow playout. Early/late incoming drops are still green.
Normal APK/test APK/JVM48/lint passes. Prepare the next stable Player facade,
single focus/noisy and connection of the service/planner; no production DJ yet.
