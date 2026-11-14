# S2t: album/artist bookmarks and confirmed refresh

First validated vertical; it is not yet full entity/Discover parity.

First vertical: Save/Remove from saved in menus of acquired albums/artists and
collection header, with explicit library identity. PUT saved-entities confirms
the returned collection and refreshes the snapshot of the same account; it does not save songs,
acquire files or start playback. It reuses pure identity helpers from
web without importing web stores/navigation/audio. The state is cleared when the account is closed.

The Android refresh must coalesce concurrent calls of the same account and wait for
the queued refresh before releasing the caller; an old response never changes
the new account. The main S2s regression detected the Saved menu captured before
the refresh that replaced the one started by saving had finished. Fix and check
the real CatalogSearch walkthrough; do not remove its assertion.

Acceptance: HTTP/HTTPS; save/remove album and artist, persistence after recreation
and logout/login, owner does not see member bookmarks, IDs/playlists/Saved-song intact,
empty program and no HTML audio. Unit tests of explicit intent, equal names
with different IDs, double selection, pending response from a previous account and
concurrent refresh. APK walkthrough validated; repeat main/restart regression.

The bookmark lists of external entities and Discover navigation still need to be
implemented; this vertical offers actions on acquired entities. Do not put
save buttons in the shell or confuse bookmark with offline copies. The rest
of the matrix, DJ/Live/Auto and signing/update remain open; do not publish an alpha.


## Validation

Typecheck/Vitest **1,416 /163**, Python saved-entities **15** pass. Combined APK
**four tests, zero failures/skipped**, HTTP/HTTPS verified for EntityBookmarks and
CatalogSearch in `/tmp/soundsible-s2t-native-confirmed.log`; it includes the
Saved failure found by the S2s regression. Normal APK/test/lint without temporary CA pass.
[Refresh fix](REFRESH_CONFIRMATION.md) pushed separately as `190c5b4`.

The first bookmark failures belonged to the test: awaitReady requires unconfigured
and does not work after recreating an account; wait for authenticated Library and boot completed.
Then textContent included the aria-hidden selection checkmark: the
label is identified without requiring that decoration to disappear. The persistence/account
and membership assertions are kept. [Evidence](evidence/s2t.json).

The scoped APK was prepared with a dirty previous HEAD. It is not a clean release build.
The last full suite S2s33 had one CatalogSearch failure; the last fully green one
S2q31+restart2. Repeat main/restart with these advances; the four browser profiles
will be repeated before the cumulative PR. No CI/live provider/phone/car accepted.
Continue until full parity and then authorized PR/merge/release.


Final regression after isolating the fixture auth budget: **35 main tests
and two persistent offline phases pass**, zero failures/skipped, from clean cf01599
when preparing assets. Normal APK/test/unit/lint pass without temporary CA; helper exit0.
Log `/tmp/soundsible-s2t-main-isolated.log`. It closes the failures of the two previous main
runs; it does not delete their evidence. OS selector and embedded artwork are still pending,
as are external entities/Discover and the rest of the matrix.
