# S2aa: delete an acquired file from Android

Implementation connected to the three-dot menu, with confirmation and shared
translations. Cancelling does not write. The controller coalesces by account/ID and requires
DELETE followed by a private no-store snapshot that proves absence. A 404 only
allows recovering an earlier removal after checking that absence again.
Responses from another account do not modify UI, programme or copies.

`retireSource` validates UID/generation and removes all local occurrences by
ID, keeping previews, keys of survivors and programme identity.
Media3 keeps position/pause when the current one survives, selects a successor
when the current one is removed and closes modes/programme when it becomes empty. The bridge
waits to observe the effective removal. Radio/autoplay invalidate pending
requests and exclude removed local sources; the specific acceptance of a
deliberately delayed planner response is still pending.

The copy is removed after the engine confirms. The store marks the work
invalidated before deleting files, cleans all playlist references and
keeps storage errors for recovery. Success is not announced if
the filesystem fails. The manager shows the removal error and allows repeating
"Remove from this device", without offering preparation over a broken leftover.
Copies deleted remotely are still kept and are eligible for
removal from the local filter; no automatic eviction is added.

Acquisition considers only pending/downloading as active: a completed receipt
does not block acquiring a removed song again. The account and
durable confirmation guards are still in force.

[Evidence record](evidence/s2aa.json).

## Evidence and limits

Full UI: 1,465 tests / 172 files pass in
`/tmp/soundsible-s2aa-final-ui.log`. Backend lifecycle: 12 pass in
`/tmp/soundsible-s2aa-lifecycle.log`. Native JVM: 17 pass in
`/tmp/soundsible-s2aa-native-unit.log`, including removal ranges and a real filesystem
with failed deletion/recovery. The integration helper now runs
`:app:testDebugUnitTest` in addition to APK/test APK/lint after removing the temporary CA;
assembling the instrumentation APK does not replace running the JVM tests.

Four instrumented HTTP/HTTPS cases pass in
`/tmp/soundsible-s2aa-recovery-native.log`: real acquisition pipeline, file
shared between accounts, playlist with duplicate references, cancellation,
paused preview at 20 s kept, successor, closing of the last song, copy and
failed/recoverable filesystem. Assets prepared from 5ddc166 with dirty=true.
Normal APK/test APK/lint pass after removing the temporary CA.

The extension for a copy deleted by another client passed HTTP/HTTPS in
`/tmp/soundsible-s2aa-final-native.log`, but the set failed two cases of
opening the manager. The later isolation identifies a WebView TypeError:
progress.value=undefined is not a finite double; HTTP fails and HTTPS passes depending on
when the size arrives. Log `/tmp/soundsible-s2aa-manager-diagnostic.log`.
Now an unknown size renders progress without value/max, and a known one uses
numbers. A test with the strict setter fails with the previous source and passes
with the fix (`/tmp/soundsible-s2aa-progress-before.log`). The rerun of
the four cases is in `/tmp/soundsible-s2aa-progress-native.log`, assets from
37d1669 dirty=true: four cases pass, zero failures/errors/skips.
Normal APK, test APK, JVM17 and lint pass after removing the temporary CA. Repeat the full main suite
plus two offline phases from a clean commit. No result certifies physical
listening or full parity. Then continue with Library/Discover/Settings, DJ,
Live, Android Auto, signing and update; PR/main/alpha only when the gates are closed.


## Local recovery keeps the online library

The update after the filesystem error rereads only the offline state. The
restoration of the local user/library is reserved for startup without network;
do not replace the online snapshot or mark the station as unreachable because of a local error.
OfflineRemovalTest requires absence of the station-unreachable notice and presence
of the original saved preview after the error. Two HTTP/HTTPS cases pass within
targeted6 of /tmp/soundsible-s2ab-native.log, assets4e04083 dirty=true;
normal APK/test APK/JVM17/lint without CA pass. UI1465/172 passes in
/tmp/soundsible-s2aa-online-recovery-ui.log. Do not attribute this later fix
to the clean main suite dc29b73.
