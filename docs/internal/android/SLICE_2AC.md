# S2ac: Account settings shared with Android

First Settings vertical; it does not replace the full matrix. Extract the existing
Account section to a shared view without audio stores, with injected user,
operations and preferences. Web keeps its current adapter; Android
uses native transport, account/generation/epoch and cancellation. Keep the original labels,
confirmations and rows: display name, username, password, search
history and logout. Do not show categories with actions that do not exist yet.

Confirm the profile from the response and auth/state; reject an old response/changed account
before writing UI. Do not lose keys, pause20s, program, profile or copies
when changing the name. Password change uses the native cookie/Keystore, never logs or
public state; demonstrate a real login with the new password and restore only the
fixture account. Logout keeps its current close/cancellation policy.

Shared history through injected storage: Android origin+account namespace,
same semantics as web (off removes recents, maximum8, deduplication). Native
Discover must use that same preference and show executable recents; without a network it does not
create a search or remember another account. Do not reuse the global web userKey of
a different session or mix two servers with the same local ID.

Tests: shared view cancel/reject/confirm/stale/unmount and account namespace;
full UI; HTTP/HTTPS APK with real editing, isolation, preservation of audio/
offline, Back and password/login/logout. Prepare assets before instrumentation,
remove the temporary CA and verify normal APK/test APK/JVM/lint. Main53+restart2
on03e3446 in progress; do not change its native sources or its artifact.

Then Appearance and remaining Settings sections, complete Discover/entities,
DJ/Live/Auto, signing/update, PR/main/release. Do not publish a partial alpha or end the
turn for this slice.

UI/controller implementation in progress: shared AccountSettingsView, history storage
injected per origin/account, mutation guard confirmed by
receipt + no-store auth/state, native SettingsAccount with abort/lifetime and
confirmation. Native Discover remembers only current responses and allows
repeating/removing recents; off clears both domains. Full UI1484/176 passes in
/tmp/soundsible-s2ac-account-ui.log, including cancel/reject/obsolete/unmount,
confirmation/password and history isolation. APK walkthrough still pending.
Do not attribute this UI to the clean artifact03e3446 of main53.


## Native walkthrough accepted

HTTP/HTTPS2 passes in /tmp/soundsible-s2ac-bootstrap-native.log; assets06004af
dirty=true. Cancelling the name does not write; name/username confirmed by snapshot,
duplicate username rejects, incorrect password keeps the cookie and the correct one rotates the
encrypted cookie. A new connection decrypts the Keystore value; real event connections
are observed after the mutations. The program keeps key/programToken/pause20s
and the private copy; recreating the Activity keeps state and session. Logout confirmation,
owner with its own preference and a new member login with new username/password
prove isolation and persistence of history. No cookies in logs/JS and no HTML
audio. APK/test APK/JVM17/lint without temporary CA pass.

Failures fixed during acceptance: the username row includes a hint (exact locator
obsolete); test callbacks wrap const per WebView evaluation. The
Settings exit now respects revalidation busy the same as the header, avoiding
offering an action that leave() was going to ignore. Real confirmation test with
changed snapshots and busy→ready test pass. Full Browser4 accepted: Chromium278/66 and WebKit269/75, zero failures;
logs /tmp/soundsible-s2ac-{chromium,webkit}.log. Later Main55+restart2
pending; the last clean artifact03e3446 has53+2 and not this UI.

This vertical does not complete Settings: Appearance, roles/admin, devices,
services and remaining sections are still pending, together with complete Discover,
DJ/Live/Auto and signing/update. It is not equivalent to an alpha.
