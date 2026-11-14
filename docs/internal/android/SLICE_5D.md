# S5d: changes to local copies in Auto

HTTP/TLS block 8/0,101.090s: CarOfflineExpiry2 + CarEvents2 + CarLibrary2 +
OfflineTest2. Targeted extension of the completion test CarEvents2/0,38.286s.
Both runners exit0, APK/test APK/JVM54/lint without CA.
[evidence](evidence/s5d.json) identifies sources and scope of both blocks.

OfflineStore publishes native signals for completion/error, removal, invalidation,
clear and effective label changes. It does not publish bytes/paths or each
progress block. Identical metadata does not rewrite the DB or notify again. Car subscriptions
observes only while there are subscribers, groups refresh and removes the observer on reset/
close/last unsubscribe. The identity includes the verified offline profile when
there is no cookie; it does not open a network socket without a cookie.

With headers delayed 5s, the Activity is closed before the copy completes. Browser
receives count1 when it completes and count0 when it is removed; the NORMAL program keeps KEY and
PCM. With an expired cookie/backend 503, a cache metadata update and a
removal also notify. That update is the local cache primitive,
not an edit of the server without a connection. When no copies remain, root is denied;
logout and previous offline tests still pass.

Pending: controls/metadata during DJ, real loss/reconnection and external UID/
host. SameUID/AVD does not prove listening or a physical car. Not complete parity/release.
