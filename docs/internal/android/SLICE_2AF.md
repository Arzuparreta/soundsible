# S2af: Remaining Settings and real effects

Prepare after accepting S2ae, without labeling its pending walkthroughs as
parity. Reuse SettingsRows and pure views; separate web dependencies before
importing a section. The shared settings catalog is the reference,
not the current short list of NativeSettings.

1. Accessibility: persisted haptics and physical feedback through the native bridge,
   respecting the preference; shared navigation destination editor connected
   to real Android routes. Never present a destination that is only a placeholder.
2. Playback: autoplay already has a confirmed native contract; connect its
   settings without another audio owner. Leveling and DJ mixing require a real
   effect in the native program, not only PUT or switch. Their acceptance is coordinated with
   the S3 DSP and must cover current/cued/background, without double playback.
3. Learning/reset: real Core endpoints, confirmation, confirmed response,
   recoverable error, cancelable account/origin. Engine diagnostics with
   measured/unknown state; do not invent Android network quality from that reading.
4. Library/admin/devices/services/Subsonic/sharing: inventory contracts and
   permissions; port complete actions, without imports of web stores/audio/session.
   Roles, changing permissions and old responses must have negative tests.

Each block must provide full UI, browser4 if it extracts web views, HTTP/TLS APK
with real Core, persistence/account change tests and evidence of effect.
Do not publish an alpha for having complete Settings: DJ/Live/Auto/signing/update remain
explicit gates. Continue commit/push toward authorized PR/main/release.

## Feedback: platform decision prepared

Use `View.performHapticFeedback` and Android constants for tactile feedback on
actions, without the VIBRATE permission or flags that ignore system preferences.
The Soundsible preference must cut the request before the bridge; Android
can reject the effect depending on hardware/settings, which is not an audio error.
Official source consulted: [haptics API](https://developer.android.com/develop/ui/views/haptics/haptics-apis)
and [event feedback](https://developer.android.com/develop/ui/views/haptics/haptic-feedback).
The emulator can test scope/configuration/requests and the absence of an extra permission;
it does not demonstrate the physical sensation. Do not import stores to read that preference:
lib/haptics.ts already reads it from storage and allows a small adaptation.

## Settings continuation in sources

FeedbackPlugin uses performHapticFeedback without flags or the VIBRATE permission; main
installs the exclusive native transport and the shared preference. Manual Play,
program controls and confirmed favourite request feedback; an account
change does not reset an installation preference. FeedbackSettingsTest HTTP/TLS
is in the targeted16 run of /tmp/soundsible-s2ae-review-links-native.log; do not
accept it yet until the final result. UI1526/189 passes before the Learning block.

After preparing that artifact (Native sources/assets frozen), Learning
UI sources were added: controller without invented editable values, confirmed PATCH and GET,
reset DELETE after cancelable confirmation, old response
aborted on account change/disconnect/unmount, shared view and Android route.
Four controller tests and targeted10 Settings/Rows pass. This Learning
is NOT inside the review/feedback APK: it requires a new prepare and Core
HTTP/TLS integration. Missing: diagnostics, autoplay in Settings and the leveling
/mixing DSP effect; admin/services/devices/sharing/navigation and the global gates continue.

Later full UI1532/191 passes /tmp/soundsible-s2af-learning-diagnostics-full-ui.log.
Diagnostics extracted to a shared LinkStatusView; Android reads /api/playback/link
on open inside a cancelable scope, without inventing samples or keeping the reading
of another account. Two tests cover old response, disconnection and invalid
payload. New APK prepared on f4cf550 dirty=true; targeted Settings6 in
/tmp/soundsible-s2af-settings-native.log: Learning2, Feedback2, Appearance2.
Freeze Native/tests/fixtures/assets during main and the normal build. Native Learning
checks the real effect of learning off on events, Cancel without DELETE, reset of
member signals/events without deleting the owner, Activity persistence, 503 with
retry and program/session intact. Do not accept until finished; then browser4,
commit/push and clean extended main with restart2 before advancing DSP/S3.

First Settings6 fails2 only when expecting a local alert on503: the real
connection marks the app offline and the controller discards its old scope. Both cases
pass learning off, Cancel without DELETE, member reset with owner intact and
Activity before that. Feedback2/Appearance2 pass. Do not accept that failed run. Expectation
corrected to the unreachable state of Recommendations and general Retry, keeping
the preference/cookie/program checks. Repeat6 in
/tmp/soundsible-s2af-settings-recovery-native.log with the same assets; only
the Native expectation changed. Keep the freeze until normal build/CA removal.

Repeated Settings6 ends with0: /tmp/soundsible-s2af-settings-recovery-native.log,
zero failures/errors/skips. Normal APK/test APK/JVM17/lint pass and temporary CA
removed. It confirms global recovery503, real/persistent off preference, cancelled/confirmed
reset and owner intact. Full UI1534/192 passes
/tmp/soundsible-s2af-settings-final-ui.log; it includes the shared web Autoplay view
and two tests of a future Native section not yet connected and not inside that APK.
Browser4 of the new extractions pending. Do not confuse accepted Settings with
complete leveling/mixing/administration/services/sharing or with global parity.

[S3a preparation](SLICE_3A.md) fixes the real loudness rule, the PCM tap and the
single-output requirements. CompositionPlayer was checked against documentation and
source of the tag used; reconfiguring the composition recreates holders. Do not assume that this
resolves a DJ route edited while running, and do not import the package-private AudioGraph.
No DSP delivered yet; Native Settings Autoplay is connected in a continuation.

Full Chromium278/66 passes without failures in /tmp/soundsible-s2af-settings-chromium.log,
1worker. Next WebKit sequential readonly/1worker in
/tmp/soundsible-s2af-settings-webkit.log. Web entries frozen during the runs;
the later Native Autoplay only changes mobile modules and their instrumentation.
Native Settings Playback already connected in sources to runtime.execute/autoplay state,
without another controller or audio. Four targeted UI tests check no editable defaults,
reactive receipts through Settings and waiting for confirmation. Extended AutoplayTest
HTTP/TLS keeps the original menu, disables/enables from Settings, verifies
real refill/removal and Activity/programToken; targeted APK still pending after
completing browser4 and full UI. Clean extended main pending73+2.

Full Browser4 accepted: Chromium278/66 and WebKit269/75, zero failures, same
closed server4173, sequential1worker and WebKit readonly. Logs cited above;
own Vite stopped. Shared extractions Haptics/Recommendations/Link/
Autoplay keep the web UX. Later Native Autoplay route changes still
require their new APK; they were not inside the previous Settings6.

Full UI Autoplay/gain1536/192 passes in
/tmp/soundsible-s2af-autoplay-gain-full-ui.log. New assets e4700ed dirty=true
are prepared for targeted10: Autoplay2/Closure2/Learning2/Feedback2/Appearance2.
The normal build must run20 JVM with the three new vectors/native S3a rule.
Do not prepare or touch Native/tests/fixtures/assets during that runner; its
UI/Root changes are frozen to accept the exact behavior of the new route.

Autoplay10 accepted: /tmp/soundsible-s2af-autoplay-native.log ends with0, zero
failures/errors/skips. It includes previous controls+Settings with refill/removal,
Repeat/Radio/background/Activity/programToken, Closure2 and Settings6. Normal APK/test APK/
JVM20/lint pass without temporary CA. The three S3a gain JVM tests pass;
no DSP connected. UI1536/192 and browser4 278/66+269/75 accepted. Save commits,
prepare clean and main73+restart2 before changing native runtime/DSP.

Clean extended main accepted46a6c3d dirty=false:73/0+restart1/0+offline1/0,
normal APK/test APK/JVM20/lint without CA pass. Runner ends with0 in
/tmp/soundsible-s2af-main-clean.log. Native/tests/fixtures/resources/assets sources
frozen during the whole runner; later Subsonic UI not included.
