# S5c: Auto copies after the cookie expires

**8/0 HTTP/TLS,60.403s**, runner exit0: CarOfflineExpiry2 + CarEvents2 +
CarLibrary2 + CarLegacy2. APK/test APK/JVM54/lint without temporary CA pass.
[evidence](evidence/s5c.json) keeps the hashes of the validated code.

An expired cookie is not equivalent to an observed revocation. In accordance with Offline B,
the verified local profile can serve only complete copies. Its native
identity derives from the profile and does not cross IPC. The previous online cache becomes invalid;
root checks copies in a worker and only exposes "Available offline". Core
folders are denied and search only filters complete copies. ProgramQueue checks
file/profile before resolving playback. No implicit acquisition or network.
Without a cookie, artwork is a placeholder, as Offline B requires.

The disposable fixture retimes Set-Cookie, keeping HttpOnly/TLS. The native jar
consumes it; the Activity is destroyed and APIs return503. After expiry, the browser gets
the local tree, plays a file and searches/plays a copy with real PCM. Root/online
actions are denied and a title from another account does not appear. Logout deletes copies
and program. Observed401 is validated in CarLibraryTest of the same block.

It does not test remote revocation of the token or revalidation when the backend recovers;
it expires the client cookie in a controlled way. Changes of local copies,
real reconnection, DJ controls/metadata and external UID/host are still pending.
It is not full parity, release or acoustic/physical acceptance.
