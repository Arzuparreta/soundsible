# S4h — Live room authorization and lease

Host and guest wait for Socket.IO to accept the room before opening WHIP/WHEP.
The wait is limited to 10s and can be cancelled on leave/reset; rejecting the socket
does not allow listening to a public stream using another room identity. The
callbacks and the HTTP responses keep ownership of generation/peer.

A guest that loses its socket for 10s ends playback, removes the peer
and keeps the manual retry. Its connected state requires both media and socket.
The host has the same lease loss limit. The fixture controls only
disconnect real sockets of their room/role, without exposing this action in production.

The extended acceptance checks a guest with a nonexistent room but a valid WHEP:
it must not decode PCM. Then it listens to the correct room and runs the earlier controls
and recovery. Host and guest lose their sockets with the Activity
closed; the Live audio ends, the host keeps the local program and Community
removes the room within its grace period. A polling-only test leaves 35s of silence and
requires zero disconnections, including the real server ping at 20s.

Validation: Host4/Listener2 pass in the combined 9/2; the failures were a
race in the UI test when sending chat before the title change finished and its
room not being cleaned up, contaminating Polling. Only the tests were fixed; UI2/Polling1
pass 3/0, runner exit0 and normal APK/test APK/JVM56/lint without CA. Product
identical between both runs. See evidence/s4h.json; do not claim a joint 9/0.
This is not full Live yet. Missing: process/resume409, reset during creation and
recovery exhaustion. A dead process can leave the publisher occupied in
MediaMTX while Core resume rotates its tokens: validate this continuity before
considering resume implemented. Do not publish or merge; manual review in the PR.
