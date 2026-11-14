# S2as — Continuation and retry of the deferred catalog

A matcher400/404 removes only the pending occurrence and continues to the
next song of the program, keeping the pause/play intent. It does not
interpret authentication, certificate or server failures as a missing song.
If there is no next one, it stops the program.

The pending source has its own bounded policy: two retries for
429/5xx with Retry-After and budget30s, and two socket/timeout retries. It does not
depend on the preview observer, which does not yet have a YouTube identity.
When exhausted, it keeps the song for explicit Retry. The pending references
are not converted into local sources for DJ requests/references in menus.

DeviceCatalogSession HTTP/TLS2/0,51.339s tests matcher404 followed by PCM, two
503 recovered, exactly three attempts exhausted without new requests, explicit
Retry with PCM and reset during a slow matcher. WholeUI210/1617 + TS; fixture
Core1/0,22.89s. Main regression/browser4 and physical listening pending.

Runner exit0 and normal APK/test APK/JVM56/lint without temporary CA pass.
Log `/tmp/soundsible-catalog-recovery-native.log`; evidence/s2as.json.
