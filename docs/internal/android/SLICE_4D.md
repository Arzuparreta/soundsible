# S4d — Live listening in MediaSession

`NativeLivePlayer` integrates WHEP into the service's stable router: one native output,
room metadata, pause/play/volume/stop/prepare and focus/noisy ownership through
`ProgramAudioFocus`. It does not announce seek for Live. Reception never feeds the
programme's post-DSP tap. PCM diagnostics stay in process, without JS or IPC.

The private liveListen command switches backend and the canonical selection of a
song returns to NORMAL. The first run detected a product failure:
SET_MEDIA_ITEM/CHANGE_MEDIA_ITEMS were not announced, so MediaSession did not accept
the selection of local music while listening to Live. These commands go through the service's canonical
resolution; external clients still do not have CHANGE_MEDIA_ITEMS permission.

LivePeer holds volume before onTrack, allows diagnostics without muting the
output and uses an internal PCM provider for the test's independent synthetic
sender. Production still uses exclusively the post-DSP LiveProgramInput,
without microphone capture. Owner/detach is released with both input types.

Acceptance: Listener HTTP/TLS + Host HTTP/TLS + Relay HTTP/TLS + Input three cases,
9/0, runner exit0; normal APK/test APK/JVM54/lint pass without temporary CA. See evidence.
Listener uses an independent synthetic source and a real relay: PCM received,
MediaSession play/pause/volume, Activity closed, new stop/prepare and return to
NORMAL. With Live PCM received >500 RMS, LiveProgramInput returns silence,
checking that listening does not turn into a broadcast source.

Focus/noisy are connected to the tested DJ owner; specific acceptance of
Live interruption is missing. There is also no physical listening, UI, socket/metadata
as guest, artwork or automatic recovery of the media connection. It is not
parity or the current main regression.
