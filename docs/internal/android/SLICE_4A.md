# S4a: native programme input to WebRTC

LiveInputTest3/0,12.817s; runner exit0, APK/test APK/JVM54/lint without temporary CA.
Real NORMAL over HTTP and TLS plus synthetic input. [Evidence](evidence/s4a.json).
Two Python tests verify checksum, rejection of altered bytes, preservation of
JNI/other classes and reproducible rebuild from cache without network.

GetStream WebRTC pinned by SHA256. Only its Java recorder is replaced
by a JNI-compatible adapter; it never creates AudioRecord or requests the microphone.
The native binaries do not change. Licences/notes included in the assets of the prepared
AAR; the normal APK is validated again after adding those assets.
[Dependency and maintenance](../../../android/third-party/webrtc/README.md).

LiveProgramInput consumes the native post-DSP/pre-volume tap in a worker, converts
channels and resamples through Media3 to stereo 48k. Maximum buffer 1s, pause/logout
do not deliver queued audio. NativeProgrammeOutput receives the playing state from the service;
the recorder sends 10ms blocks and zeros during pause, without PCM callbacks to JavaScript.

One peer encodes Opus and another decodes with AudioTrackSink. With real Core music
mono 16k, received RMS>500; local volume 0 does not mute the broadcast. Pause produces RMS<20,
resume recovers the signal. No microphone permission granted.

Not yet: WHIP/WHEP relay, room/chat/UI, lease/background/reconnection, DJ to the
receiver or acceptance of exclusion of received Live. Do not claim complete Live.
Next: WHIP/WHEP transport against an isolated relay and then native room end to end.
