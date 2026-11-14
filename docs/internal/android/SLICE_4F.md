# S4f — DJ programme and Live covers

The host takes a coherent observation of the native output clock to choose the
dominant track, the second track, the gains and the progress of the transition.
It publishes the phases and techniques of the shared Live protocol. Pause keeps the
main track and removes the transition; local volume does not change the
programme gains. Audio received from another room is never announced as its own broadcast.

Private covers are loaded through ProgramArtwork, without changing its
authentication policy. A separate worker publishes JPEG thumbnails of up to 256KiB with
the host token in Community. Cache and pending work are bounded and bound
to the room/generation; a failure waits 60s before retrying. Core cookies
and secrets do not travel to JS. Ending/reset cancels the image requests.

The listener only accepts HTTPS on the selected Community origin and within
`/v1/artwork/<room>/`. It rejects redirects, other rooms, excess bytes and dimensions
greater than 512px. It inserts the validated image into MediaMetadata so that the existing
notification/MediaSession path can decode it. Changing track or
closing playback invalidates pending results.

Acceptance: Host4/Listener2, 6/0 in 76.723s, Core HTTP/TLS. Real DJ goes through the
relay with overlap metadata; NORMAL publishes its private cover and the guest
receives a decodable public cover in MediaSession. Other rooms/origins
are rejected. Runner exit0; APK/test APK/JVM54/lint without temporary CA pass.
See evidence/s4f.json. The Live UI/Relay/Input regression is left for the next
joint block. It is not parity yet.

Next: peer/network recovery, lease and long polling; cancellation during
handshake and process death. Then, close the phone/DJ/Auto gaps,
signing and full regressions. PR open for manual review, without automerge.
