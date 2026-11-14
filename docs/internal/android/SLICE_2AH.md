# S2ah: sharing songs from Android

The shared song menu (library, resolved catalog and queue/route) offers
"Share". SharePlugin opens ACTION_CHOOSER/ACTION_SEND text/plain; it does not attach
files, audio URIs, cookies, the account origin or file permissions.
Music with a video identity uses the public capsule in the trackShare fragment,
like the web; local music without that identity and podcasts share title/artist.
The textual metadata is bounded before crossing IPC. Delivery to the receiver is not claimed:
`opened` only confirms that Android accepted opening the chooser.

The action keeps the account/generation scope and requires an active window. An old
menu does not migrate to another account; native validation rejects a previous generation and a URL
with credentials/query/incompatible fragment. Sharing metadata does not require
reconnecting an account that keeps its offline library.

Validation on dirty `23c5c416`: Share2 + LibraryActions2 + DjContext2,6/0
HTTP/TLS,57.095s instrumented; normal APK/test APK/JVM54/lint without CA pass.
The instrumentation monitor intercepts the Android Intent: it tests menu/plugin/
payload and rejection, without sending to target applications. UI201/1584 + TS.
Logs and limits in [evidence](evidence/s2ah.json).

It does not close sharing/invites/deep links or phone parity. Reception of
capsules, cold/warm intents, invitations and multi-device are still pending.
Check the real chooser and receiver during manual acceptance; do not confuse the
monitor with that acceptance. The channel is still development, without a public alpha.
