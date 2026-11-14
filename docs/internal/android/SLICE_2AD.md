# S2ad: shared Appearance and visual preferences

Share the current Appearance and DisplayPreferences views through props,
without importing audio stores in the Android bundle. Keep labels, the order of the
six themes, language, size and contrast. Web keeps its adapters. Android
applies local installation preferences also without an engine, with persistence
that does not depend on the account and does not change program/copy/session.

Use the shared boot theme table; follow system changes and restore the
state after returning from the background. Adjust document/theme-color and contrast of the
Android bar icons, with a native bridge limited to appearance and without access to
credentials. Revalidate state after recreating the Activity and starting without an engine. The
language selector must use the four existing dictionaries and update
lang/labels. Do not offer haptics as validated only through navigator.vibrate: their
acceptance and the customizable navigation will be documented separately.

Acceptance: tests of invalid/restricted storage and system change,
shared view and reactivity; complete UI and four browser profiles.
HTTP/HTTPS APK: light/dark/extra/system theme, language, size and contrast,
recreation and offline keeping key/programToken/pausa20s/copy/session. Verify
native bars and absence of HTML audio. Prepare clean sources and extend the
main run; keep the results of S2ac and S2ad separate.

Afterwards complete Playback/recommendations, devices/services/admin and
Discover, DJ/Live/Auto and signing/update; this is not equivalent to parity or alpha. Continue
with current authorization up to PR/main/release after the complete gates.


## Implementation and diagnosis

AppearanceSettingsView and DisplayPreferencesView share the UI with the original web
adapters. NativeSettings offers Account/Appearance/Accessibility and Back
returns first to Account. Per-installation preferences, shared boot table,
common locale, tolerated restricted persistence and re-read when becoming visible again.
UI1489/179 passes before the final bar adjustment; the complete UI is repeated.

First target6: Appearance2 fails after a real OS mode change; Account2 and
Offline2 pass. Capacitor's integrated SystemBars keeps its own style and
reapplies it during configuration, overriding the manual bridge. The adapter now uses
SystemBars.setStyle before the bridge limited to the background. Second target6 confirms
bars/background/system and fails geometry: the new nav outside the library class had
bottom buttons under 44px. Added the shell class; corresponding target pending.
Logs /tmp/soundsible-s2ad-{native,system-bars-native}.log. Do not treat these targets
as accepted or replace the clean principal53.

Browser: first Chromium278/66 passes; WebKit268/75 fails the inert queue context because of
synthetic scroll during alignment (SLICE_2Z; fix 3cb261f). Second
Chromium277/66 detects popup without fixture/visibility: a background tab
can keep the first render pending. The test now applies the fixture to the context,
waits for the original boot, shows the popup and checks the real detail page before the keyboard.
Five Chromium repetitions pass /tmp/soundsible-s2ad-popup-visible.log.
Complete four-profile regression repeated; do not replace the failed result
with only the targeted cases.

Principal55 aad83d4 had 54 green and an OfflineTest TLS failure when tapping Play after
recreation. Replay2 with the original sources/assets passes plus normalAPK/testAPK/
JVM17/lint. The helper now waits for the button to be actually enabled/boot and captures
snapshot/click for diagnosis; it does not change the offline audio checks.
Repeat the extended clean main run after accepting and saving S2ad.


## Accepted Appearance walkthrough

HTTP/HTTPS2 passes /tmp/soundsible-s2ad-geometry-native.log, sources 3cb261f
dirty=true. Six themes, real OS flips and explicit mode kept, native icons
and window background, Spanish language, large size/contrast, 44px buttons and bounded
width, recreation and engine 503 pass without losing key/program/pausa20s/copy/session.
No HTML audio. Normal APK/testAPK/JVM17/lint without temporary CA passes. Account/Offline4
passed in the previous target6 with 2 geometry failures; do not call that target6 green.

Complete UI 1489/179 passes again in /tmp/soundsible-s2ad-ui-serial.log. Two
cold import timeouts of 5s with Chromium/Gradle running simultaneously are distinguished from the
accepted serial result; do not extend product or test timeouts.
The mobile header keeps its geometric checks, now in a single frame
and through polling: reading two independent boundingBox could capture a
control replaced during resize. The four complete profiles run again
sequentially before the commit of the capability. Principal57+restart2 afterwards.


The atomic measurement extended the diagnosis to all controls and found the
clickable AppBar title under 44px, not measured before between first/last. Fixed
min-height 44px in the shared component. Previous serial 268/66 with 10 failures not
accepted: 9 small titles and 1 popup while the link was moving. Ctrl-click now
waits for settledBox, keeps real interaction and the new detail page check.
Targeted Chromium 28/20 without failures; repeat the complete suite and then WebKit.


## Complete S2ad regression accepted

Chromium278/66 and WebKit269/75, zero failures, the four complete profiles
sequential with 1 worker like CI. Logs /tmp/soundsible-s2ad-{chromium,webkit}-ci-worker.log.
Real popup keeps Ctrl-click/foreground, waits for DOMContentLoaded and the complete
detail page; eight repetitions with trace pass. With 8 workers one case keeps waiting for the
URL even after DOM readiness; do not declare that run green. S2ae during
the runs only changed Native and added shared views not yet connected; the
measured web inputs stayed the same. Complete UI with S2ae bases is repeated
before preparing the clean artifact/principal57+restart2. Not parity or alpha.


Clean principal 8329de5 dirty=false accepted: 57 plus restart prepare1/offline1,
zero failures/errors/skips. Normal APK/testAPK/JVM17/lint without CA pass.
/tmp/soundsible-s2ad-main-clean.log and evidence/s2ad.json. Later S2ae UI in
sources does not affect that frozen artifact. Continue until parity and PR/release.
