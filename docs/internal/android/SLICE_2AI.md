# S2ai: receive shared songs

Android receives `soundsible://open?shared=<capsule>` through ACTION_VIEW and the
text of an ACTION_SEND text/plain with a single compatible public link.
The shared parser limits size, fields, video identity and metadata. It does not
accept server configuration, credentials or autoplay instructions.
It is not registered as a verified HTTPS Android App Link: automatically opening
the public page in the app still requires the integration of the public bridge.

The pending selection has a token independent of the account and persists before
login. The interface shows title/artist and allows closing it; playing or
opening actions requires an active account and a prepared player. Receiving it does not
change the queue, position or pause. Explicitly playing first looks for a canonical
song in the account's library; otherwise it uses the validated preview identity
and lets the native adapter build the source, without received URLs.

The last intent takes precedence over a delayed initial read. Acknowledgements
per token do not discard a later link. After the selection is consumed, recreating
the Activity does not run its initial intent again. The pending public selection
is kept in private preferences; it does not store server information.

Validation on `9450752c` dirty: Incoming2 + Share2, **4/0 HTTP/TLS**,
29.504s instrumented; APK/test APK/JVM54/lint normal without CA passes. UI204/1595
+ TypeScript. The first compile failed because of a nullable in the test; the next block 4/2
revealed a replay of the initial intent on recreation. Capacitor BridgeActivity.load
redispatches it; fixed by discarding only the initial dispatch of a restored instance.
The repetition 4/0 keeps the later intents. See [evidence](evidence/s2ai.json).

Invitations, multi-device controls and real acceptance of the public bridge
remain pending. The AVD does not demonstrate the target browser/application or a physical
device. The channel is still development and is not a public alpha.

Offline follow-up on f0e02058 dirty: Incoming2/0 HTTP/TLS, 19.214s,
normal APK/test APK/JVM54/lint without CA and UI204/1595 + TS pass. New copies
keep the validated public youtube_id; with APIs503 and the Activity recreated, Play
resolves the acquired member-track, without preview or automatic acquisition. Earlier
copies without that identity need to be prepared again to recognize the link.
