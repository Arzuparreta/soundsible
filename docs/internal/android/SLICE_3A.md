# S3a: leveling and PCM output before DJ/Live

This file prepares the DSP execution; it does not describe a delivered capability.
S2af connects preferences that already produce native effects (feedback, Learning,
Autoplay), but leveling/mixing are still pending. Do not offer those switches
until real output is verified. Keep the main run/S2 regressions and their evidence.

## Shared contract that must be preserved

- `ui_web/src/lib/loudness.ts`: source of truth of the rule. Target -18 LUFS,
  ceiling -1 dBTP, limited correction, fixed drop for unmeasured items, album
  reference only with sufficient coverage and album playback without shuffle.
  Do not copy the old `Track` comment that says unity for unmeasured items:
  it contradicts the current code. Also do not measure again from Android or announce
  nonexistent measurements. Off returns exactly1.
- Confirmed engine facts: `Track.loudness_lufs/loudness_peak_dbtp`, library
  reading and advisory `/api/loudness/request`. The measurement request must never
  block Play. Settings Core PATCH confirms `volume_leveling/dj_mixing`.
- `ui_web/src/lib/audio/mixer.ts`: equal-power, bass_swap/long_blend, filter_blend,
  echo_cut/direct; preroll/cues/limited rate/rate return; keep phase and
  dominant metadata, cancellation, stalled incoming, manual Next and background.
  Enabling mixing in Core does not run those effects by itself.
- The listening volume comes AFTER the post-DSP program capture. A
  Live broadcast must not follow the local volume or record the microphone/speaker.

## First implementable and verifiable block

1. Gain rule and PCM as small native modules, with vectors shared
   with the TS rule: measured/unmeasured/invalid/off, peak ceiling and album context.
   Transport preserves occurrence keys and the exact context of the action, without inferring
   an album only from titles/a queue that happens to have the same album.
2. In `PlaybackService.kt`, integrate processing into the AudioSink of the existing
   ExoPlayer. There is a single current owner; do not start another AudioTrack only
   to test DSP. Do not enable offload/float bypass that skips the processors.
   Accept real conversion/formats, flush, seek, track change and EOS without
   retaining buffers of a previous account or occurrence.
3. Confirmed preferences snapshot, cancellable per connection, update
   current and cued following the same contract as the web; reset when ownership is removed.
   Do not apply metadata/gain of the next item before its real stream.
4. Bounded PCM tap post-processing/pre-volume, non-blocking consumer,
   without accumulating hours in memory. It allows an amplitude/continuity test and will be
   the entry point for Live; do not publish storage/capture by default.
5. APK HTTP/TLS test with synthetic WAV/FLAC and real Core: different samples
   when enabling leveling, unity when turning it off, pause/seek/current/cued/background and
   Activity stable, invalid source/recoverable failure. The tap test confirms
   the computed program; physical acoustic acceptance remains independent.
   Keep the existing OS controls, focus/noisy, offline and private program.

## Mixing: APIs checked, decision pending a spike

The application already uses Media3 in `android/app/build.gradle` (use its real version).
[CompositionPlayer](https://developer.android.com/media/media3/transformer/compositionplayer)
allows compositions with effects; experimental API and composition timeline.
Its [source of the tag used by the repo](https://github.com/androidx/media/blob/1.11.1/libraries/transformer/src/main/java/androidx/media3/transformer/CompositionPlayer.java)
exposes `setAudioSink/setAudioMixerFactory/setMediaSourceFactory`, but
`setCompositionInternal` releases and recreates sequence holders. Therefore do not
consider resolved a dynamic DJ route that is edited while it plays.
`PlaybackAudioGraphWrapper/AudioGraph` are package-private in that tag: do not design
a public import that then does not compile and do not patch generated/cached libraries.
[AudioMixer](https://github.com/androidx/media/blob/1.11.1/libraries/transformer/src/main/java/androidx/media3/transformer/AudioMixer.java)
is public and aligns/mixes buffers; integrating inputs, clock, backpressure and
output is still our work. The choice requires a PCM/controls spike and
private sources, not only a diagram. Any alternative must keep a
consistent program output and dominant metadata in MediaSession.

Afterwards: full S3 planner/routes/direction/requests/transitions, S4 Live with
independent listener, S5 Auto with reliable browse/control, signing/update and
release gates. Do not close the objective or publish alpha for finishing S3a.

## Rule base in sources (still without AudioSink)

ProgramLoudness.kt translates the existing policy, including unmeasured items, exact
off1, peak ceiling, coverage90% and explicit album context without shuffle.
`shared/contracts/loudness_gain.tsv` contains vectors consumed by both
clients: the TS test passes38 in /tmp/soundsible-s3a-gain-contract-native-url-ui.log.
The three new native JVM tests also check weighted reference,
missing context and coverage. Pending execution in the normal build of the
next runner; do not claim they pass before seeing results. The TSV resource
is only a JVM test resource, not a user data file or APK asset.
No new DSP/audio connected yet; the PCM and scope test is still a gate.

JVM rule accepted: normal build of /tmp/soundsible-s2af-autoplay-native.log
ends0 with20 JVM tests (17 previous+3 rule), zero failures/errors/skips.
Common resource loaded from the real classpath, including weighted reference
0.5727297072924131 and coverage/context. Full UI1536/192 passes; TS rule test
38 passes. Base ready to integrate after clean main73+restart2;
do not claim it already affects samples or program capture.

## Real stream boundary in current Media3

Review of the official source of the current dependency, not a runtime test:
[DefaultAudioSink](https://github.com/androidx/media/blob/1.11.1/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/audio/DefaultAudioSink.java)
configures the pending pipeline, drains the previous one and flushes with
AudioProcessor.StreamMetadata (timeline, periodUid, positionOffsetUs).
[MediaCodecAudioRenderer](https://github.com/androidx/media/blob/1.11.1/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/audio/MediaCodecAudioRenderer.java)
delivers timeline and MediaPeriodId to the AudioSinkConfig.
[BaseAudioProcessor](https://github.com/androidx/media/blob/1.11.1/libraries/common/src/main/java/androidx/media3/common/audio/BaseAudioProcessor.java)
allows onFlush(StreamMetadata). Use that period to locate the exact MediaItem
and its facts/context: it avoids applying the gain of the current header to
buffers of the next song decoded ahead of time. There is no need to invent
an audio owner or wrap SampleStreams only to carry identity.

The processor must stay active even at unity to keep the tap and receive
stream changes. Core confirms volume_leveling/dj_mixing in discovery/settings.
Prefs can change during a stream; stream identity is fixed at flush,
the current preference is read per block inside the native scope. Moving to the next
stream cannot change pending samples of the previous one before draining them.
Tests for boundary, seek, changed source and account/generation rejection are
a requirement: the documented sources alone do not prove functional integration.

## DSP in sources during browser4 S2ag (no acceptance yet)

ProgramPcmGain adds PCM16 saturation and a 10ms ramp per frame; ProgramPcmTap
keeps8 blocks of at most64KiB, consumer outside the audio thread, scope per
generation and exclusion of Live input. ProgramPcmProcessor uses onFlush(StreamMetadata)
to resolve the exact facts/context of the period and copy post-gain output to the
optional tap. It does not store audio when there is no consumer. NativeProgramOutput
allows attachment only inside the process; there is no IPC/export or JS/mic reading.

PlaybackService installs the processor in its existing AudioSink and forces PCM without
float bypass/passthrough/offload. ProgramLeveling confirms Core PATCH and GET,
with bounded worker/queue, receipt discard per session/generation and visible state
through SessionExtras. ProgramQueue copies the source facts and the album reference
only with explicit context, without guessing it from titles.

Code pending compilation/testing: do not run Gradle/JVM/integration at the same time
as browser4. Native Track/context and Settings UI still not connected when finishing
these changes. Seven new JVM tests prepared (kernel4/tap3), not yet run.
Still gates: real PCM output HTTP/TLS/WAV/FLAC, independent local volume,
boundaries/seek/Activity/scopes and album/shuffle. Do not announce leveling or capture
as functional until there is evidence; this does not deliver DJ mixing or Live broadcasting.

## Continuation: compilation and sample test

The DSP base compiles and passes27 JVM tests (20 previous + kernel4 + tap3), plus
lint: `/tmp/soundsible-s3a-native-foundation.log`. The Solid connection of Settings,
facts and explicit context passes the full suite1550/196 in
`/tmp/soundsible-s3a-connected-full-ui.log`; browser4 S2ag precedes these changes and
must be repeated before the final PR. No JVM result replaces the PCM output.

ProgramPcmTest prepares two HTTP/TLS cases on the real AudioSink of the single
service. The fixture measures its tones with the production R128 and delivers facts
through `/api/library`; it checks unity/unmeasured/measured, weighted album/shuffle,
independent local volume, seek, Activity and background. WAV HTTP/TLS2 passes in
`/tmp/soundsible-s3a-pcm-offline-program-native.log`, followed by normal APK/test APK/JVM27/
lint without temporary CA. It includes measured copies and offline playback
from Songs and album with Core503. The earlier diagnostics are kept: nodes
during resume, Refresh without waiting for the new library and identity prior to
replacement. The waits were fixed without relaxing amplitudes or deadlines.
FLAC HTTP/TLS2 also passes, followed by normal APK/test APK/JVM27/lint in
`/tmp/soundsible-s3a-pcm-flac-native.log`. See [evidence](evidence/s3a.json).
OfflineStore keeps finite facts when preparing the copy, together with its bytes;
it does not replace them when refreshing tags because they could describe another recording.
Earlier copies without facts keep the unmeasured policy. The confirmed
preference is cached per native profile. The later force-stop protocol passes
prepare1/offline1 in `/tmp/soundsible-s3a-pcm-restart-native.log`: new service,
Core503 and PCM peak1893 on a copy without facts; normal APK/test APK/JVM27/lint
pass. The test restores the original preference of the isolated engine when it finishes.

Generated plans: Core attaches facts of the acquired recording using its hash,
queries only accepted items of that account's library and does not publish hashes.
A cache failure keeps selection/order and returns unmeasured. Native RadioPlan
preserves finite facts/duration without inventing album context. Python79 passes
with real planner WAV/FLAC in `/tmp/soundsible-s3a-plan-measured-python.log`;
Radio HTTP/TLS measures the gain of a real generated occurrence. Radio/parser/
Autoplay6 passes in `/tmp/soundsible-s3a-radio-leveling-native.log`, followed by
normal APK/test APK/JVM27/lint. Repeat the full main run on a clean commit.
Afterwards continue with [DJ execution](SLICE_3B.md), do not close the objective.

Main run from clean commit4e5b981 prepared dirty=false:
`/tmp/soundsible-s3a-main-clean-native.log`. ProgramPcmTest HTTP/TLS fails when
waiting for a two-song album because Radio from earlier cases leaves more acquired items
in `member album`. It is not a targeted green that can be extrapolated to the main run. Fix
the fixture with its own PCM album (two recordings, without removing Radio/event data),
repeat the affected tests and the main run. Keep sources frozen until the
current runner finishes; the previously accepted main XML is still73.

Run finished78/2 and exit1. The fixture now uses `member PCM album` with its own soft/loud
tracks; it does not change the original album or delete Radio/events. Radio HTTP/TLS runs
before PCM HTTP/TLS and all four pass with the extended library, followed by
normal APK/test APK/JVM27/lint, in
`/tmp/soundsible-s3a-pcm-isolated-album-native.log`. Repeat clean main run.
