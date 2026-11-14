# S5f: native reconnection of subscriptions

CarEventsTest2/0 HTTP/TLS, runner exit0; APK/test APK/JVM54/lint without temporary CA.
[evidence](evidence/s5f.json) records sources and duration. The production client
does not change: its existing retries recover the lost changes.

With the Activity destroyed, the fixture closes an existing Engine.IO transport and
rejects new handshakes with503. A label edit does not arrive during the
outage. The test waits to observe a rejected handshake; when the network is restored,
native reconnection refreshes the label, keeps KEY/PCM and respects unsubscribe.

Engine.IO processes requests before Flask hooks; the denial lives in a WSGI middleware
exclusive to the fixture. Heartbeat2+3s only during this test speeds up detection;
25+20s are restored at the end. The initial attempts did not wait for normal
detection; they are not equivalent to a client failure. Temporary traces removed.

It does not validate exhaustion of the five retries, Android handover, DJ during an outage,
external UID, Google Auto host or physical audio. Not full parity/release.
