# S2at — Invitations received from the system and pending occurrence menu

An engine invitation link (`<origen>/player/#/invite/<token>`) shared
as text (ACTION_SEND) remains a proposal: the app shows the server and does not
configure origin, cookie or account until the user taps. Without a session, Connect
opens the native S2aj form. With a session, the card warns that using it ends
the session and stops playback; Close keeps the account, and only "Use
invitation" logs out/forgets the server and opens the form. The web discards the
token if there is a session because there each server is a different origin; on Android one app
corresponds to one server, so the explicit choice is offered instead of copying
that limitation. A single latest-wins native store shared with songs; the song
reader ignores invitations without consuming them and vice versa.

VIEW only arrives with `soundsible://open`; no producer emits invitations in that
scheme, so no format was added. VIEW of https links requires the public
bridge/App Links, pending.

A pending catalog occurrence in the queue is no longer rebuilt as a library
song: its menu offers only "Remove from queue". Without the guard, the native test
observed DJ from song, delete from library, offline, edit, favorites,
playlist and share on the pending occurrence (failure verified and restored).

IncomingInvite2 + IncomingTrack2 + Invite2 + PendingQueueMenu2: HTTP/TLS8/0,
66.403s, runner exit0 + normal APK/test APK/JVM56/lint without a temporary CA.
WholeUI211/1620 + TypeScript pass. Log `/tmp/soundsible-incoming-invite-native.log`;
evidence/s2at.json. No main/browser4 regression run in this block.
