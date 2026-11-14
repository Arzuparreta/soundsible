# Android refresh confirmation after writes

The main S2s walkthrough (33 tests, one failure) found a menu opened with an old
Saved state after the write was confirmed in the engine. sync could be
replaced by another refresh (events/foreground) and return before observing the
most recent response; the caller stopped being pending and opened an old menu.

createAccountRefresh coalesces calls per epoch, runs the queued refresh and
keeps the same Promise until it observes it. A previous epoch does not requeue work
or delete the Promise of a new account. syncOnce keeps the existing identity,
cancellation, snapshot and 401/403 guards. The explicit intent
captured when opening a menu is not changed and the assertions of the Saved test are not weakened.

Two contract tests prove callers waiting for the second observation and separation
between concurrent accounts. Full Typecheck/Vitest with S2t in development passes:
1,416 tests /163 files. CatalogSearch walkthroughs over HTTP and verified HTTPS pass
with the fix, inside the filtered run `/tmp/soundsible-s2t-native.log`.
That run had two EntityBookmarks failures, which used the wait for the
unconfigured screen after recreating an authenticated account; it was not a global green pass.

Repeat main and restart on the final sources. The change is independent of
the S2t bookmarks still in validation. It does not represent full parity or an alpha.
