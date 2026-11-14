# S2z: system Back in native navigation

Implemented and validated after S2y (8cfd77c); see HANDOFF and
[evidence](evidence/s2z.json). The installed App plugin has an Android callback that goes back through
WebView history when there is no listener; the current native surfaces use
signals and lack their own history. Back does not resolve those views.

Register an App.backButton listener with lifecycle and cleanup. Order: top
context menu/modal, library/podcast detail, secondary tab,
main library and finally minimize app. Never stop/clear program or
session because of navigation. The external document picker keeps its OS handling.

Share the close semantics of the existing overlay (including historyBack),
do not simulate Escape or search for buttons in the DOM. A non-dismissable modal consumes
Back without navigating underneath. Detail handlers are registered with cleanup,
evaluated in mount order and only consume when they have something to close.
Library: collection → index of its tab; active search → empty search;
secondary tab → songs. Detail queries are aborted when going back. Podcasts: show →
directory. Other surfaces → Library. At root, App.minimizeApp keeps the media
service. Remove listeners registered late after unmount and avoid old
detail responses when going back.

Tests: registrations/disposal, top close and non-dismissable modal; APK with
system KeyEvent in collection, menu/editor/lyrics, podcasts and tab; root
minimized and return to foreground keeps keys/token/position/pause and session.
Validate HTTP/HTTPS and absence of HTML audio. Then repeat the full main
regression and continue library/Discover/Settings, DJ/Live/Auto and release gates.


UI1,438/168 and APK2 HTTP/HTTPS without failures/skips pass; normal APK/test/unit/lint
passes after removing the temporary CA. BackNavigationTest uses the system
KeyEvent: collection/tab, menu/editor/lyrics, show/directory/root, Downloads,
minimize/return keep keys/token/pause20s/session. Revoking the session with the menu
open clears private windows/data and program. No HTML audio.

Real failure found: OverlayOutlet removed DOM on unmount, but retained the
registration and history listeners. discardOverlays releases scopes without history.back;
the Android account uses it on reset. ContextMenuOutlet also clears the popover.
A non-dismissable modal consumes Back, but an account change discards everything.
The helper StartupTest.awaitReady requires a state without server; it is not used to return
from minimizing a connected app. The test checks its real connected state.

Emulator API36; no acceptance of predictive gesture/manufacturers/physical hardware.
The full main run and the four browsers will be repeated because of the global cleanup change;
then continue library/Discover/Settings and DJ/Live/Auto parity, signing/release.

The first full Chromium regression gave 277 correct tests, 66 skipped and
a timeout in mobile English Session DJ: after selecting Route, an old scroll
settle could return to Stage and leave Route inert. The earlier repair
of cancelling the RAF when accepting a gesture was already present. The remaining
conflict is the 80 ms settle before the new alignment RAF runs.
PlayerWorkspace now keeps the requested destination until reaching it; a real gesture
cancels that destination and still has priority. Two tests control RAF
and timers to cover both priorities. Full UI: 1,440 tests/169 files.
The new test against the previous code fails (Route returns to Stage); the other
test keeps the correct gesture. Log /tmp/soundsible-carousel-before.log.
Four full profiles pass: Chromium 278/66 and WebKit 269/75 (passed/skipped),
without failures. WebKit with one worker, read-only mount and after Chromium.
Repair commit: 78669b6; evidence in s2z.json. Android main run in
progress on assets of clean 502947d; do not count the isolated reproduction of
Session as a substitute for those regressions. Continue with SLICE_2AA.md.

The first full main run on 502947d found a real failure in
AutoplayTest.tlsAutoplay, stop line: Radio changes the token when adding runway
between state() and command(). The global close does not edit an occurrence or an order;
it must keep UID/generation, like pause, without a refill being able to prevent it.
Fix prepared in PlaybackService and HTTP/HTTPS test strengthened with a token
prior to switching autoplay to Radio; an old generation must be rejected and
keep the program. Fix validated: two HTTP/HTTPS tests without failures or
skips and normal APK/test/unit/lint after removing the temporary CA; log
/tmp/soundsible-s2z-stop-targeted.log. Pending: repeat the full main run.
Edits by index/key keep their token guard; do not relax those tests.

The second main run on 5ddc166 gives 45 cases, two failures in Closure HTTP/HTTPS:
the generation-only fix accepted a late close from another program.
It is a real regression, not an obsolete test. Final contract: programToken UUID
stable during append/refill/editing and different when replacing the queue or inserting
on an empty one. stop validates that token plus UID/generation; the old caller without
programToken keeps the queueToken guard. Closure keeps its rejection of an invalid order
token and adds a real queue replacement followed by a close of the previous
program with the new order token. Autoplay confirms the identity is kept after
going from autoplay to Radio/refill and accepts the close with the previous order.

The four Closure/Autoplay HTTP/HTTPS cases pass without failures/skips, and
normal APK/test/unit/lint without temporary CA passes. Log
/tmp/soundsible-s2z-program-identity-native.log. Full UI of the working tree
includes S2aa in progress: 1,462 tests/172 files; repeat the full main run after
clean commits and close S2aa end to end. The XML of failed runs are
in integration-failed; integration-results still keeps the last success.


Shared regression during S2ad: WebKit main268/75 and one context failure.
Repeated diagnosis2 failures/1 green shows context present but queue inert:
the helper's `raw scroll` competes with the explicit opening alignment, without a gesture
that removes that owner. The case of opening context now uses the real Cola button and
waits for queue to leave inert. Three mobile WebKit repetitions pass in
/tmp/soundsible-s2ad-webkit-context-fixed.log; four full profiles are repeated
before marking the regression as accepted. Do not change product guards for a
synthetic scroll.
