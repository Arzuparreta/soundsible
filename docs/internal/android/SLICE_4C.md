# S4c — Live host owned by the service

`NativeLiveHost` belongs to PlaybackService. It creates a session through the signed
Core, opens WHIP and the Community socket with the Core's cookie-free transports,
sends program/pause/position from the native player and keeps a heartbeat
independent of Activity/WebView. The controller of the same UID has
liveStart/liveStop/liveTitle/liveChat. External clients do not access these commands.

The credentials stay in the service: the start response and the MediaSession
extras contain only the public session, state, program and up to one hundred messages.
The socket collects room/presence/chat updates and closes the publisher on
receiving session_ended. Connection reset and service destruction remove capture,
peer/socket and transport; an explicit end removes the room without stopping the local program.

Targeted acceptance: LiveHost HTTP/TLS + LiveRelay HTTP/TLS + LiveInput three cases,
7/0,42.984s, runner exit0. Normal APK/test APK/JVM54/lint pass without temporary CA.
Log `/tmp/soundsible-live-host-controls-native.log`. Host tests real title and chat
echo, song/pause metadata, PCM received by the relay, heartbeat with the Activity
closed and room end while keeping KEY and local playback. The first Host attempt
failed because it compared the browse ID with the program ID; the acceptance uses
the retained occurrence identity, without modifying the product for the selector.

Pending: UI controls, native MediaSession listening, transition/DJ metadata,
public covers, resumption after process death and recovery from a mid-way network failure.
There is no targeted test of session_ended/reset during handshake or of a
long-duration lease. The seven cases do not replace the main regression or hardware.
