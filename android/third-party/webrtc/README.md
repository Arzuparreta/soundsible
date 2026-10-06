# Native Live WebRTC dependency

Pinned GetStream WebRTC release1.3.10 from Maven Central. This is a dependency
version, never the Soundsible product version. scripts/android_webrtc.py verifies
the original AAR SHA256, caches it under android/build, and reproducibly removes
only org.webrtc.audio.WebRtcAudioRecord and its inner classes. The native libraries
and all other classes remain unchanged. APK packaging supplies our JNI-compatible
programme PCM recorder under the same class name. No AudioRecord or microphone
input is created. A dependency upgrade requires reviewing its recorder ABI and
running actual encode/decode acceptance, not merely updating a checksum.

Original SDK: https://github.com/GetStream/webrtc-android/releases/tag/1.3.10
Artifact: https://repo.maven.apache.org/maven2/io/getstream/stream-webrtc-android/1.3.10/stream-webrtc-android-1.3.10.aar
SDK license: GETSTREAM-LICENSE (Apache2.0). Native WebRTC: WEBRTC-LICENSE (BSD).
Our replacement recorder is original implementation using the SDK's JNI signatures.
