# S2ae: Discover and external entities

Continuation after Appearance. Prior inventory: SearchDiscovery uses
/api/discovery/music/feed, artist/album sections and limited songs,
bounded revalidation and feedback. Android CatalogSearch only searches track and
library_track; do not consider that search to be complete Discover.

Port feed and `all` search with reusable views and injected identity/cancellation,
without web audio stores. Artist/Album pages use the
ArtistProfile/AlbumProfile contracts and reversible local navigation, including ambiguous
candidates, albums/singles/related and song list. Prefer extracting the
existing views/transformations over duplicating product labels and rules.

Separate actions: entity bookmark only /api/library/saved-entities; saving
songs keeps shared identity; acquiring songs and collections uses
existing jobs, shows cancel/retry/progress and updates the confirmed snapshot.
Play/shuffle must resolve a context queue in native transport, keep
occurrences and manual priority. Albums with the same name and compilation artist are not
merged by text. Going back restores query/section/scroll. Menus remain
the place for Available offline for acquired music.

Accept partial provider rejection, pending response from another account,
cancel/unmount, empty collection and recovery; API and preferences must stay
scoped to origin/account. UI tests + browser4 for shared extractions;
HTTP/HTTPS APK with real Core contracts and a deterministic provider fixture,
without attributing this to live providers. Real provider acceptance is separate.
Main regression extended only after preparing the corresponding assets;
do not change native sources of the artifact that is still being verified.

Remaining Settings, DJ, Live, Android Auto and signing/update are still pending.
Keep gates and the authorization to continue up to PR/main/release, without a partial
alpha or ending the turn per slice.


## Base implemented, screen connection pending

CatalogSearch delegates the existing actions to createNativeCatalogActions: same
resolve/save/remove/acquire, cancelable scope, confirmed identity and refresh of
the account that sent the mutation. The eight existing tests pass without changing
their search contract. It still filters songs; do not declare `all` search.

SearchDiscoveryView extracts the layout with injected navigation/status/song renderer,
without web stores. Not yet connected to the web adapter or to Android.
createNativeDiscoveryFeed preserves the explored section and limits revalidation to12
retries; it aborts and discards another profile even if the provider ignores abort.
catalogEntity helpers preserve IDs/Unicode/compilation credit; copies
do not imply bookmark or vice versa. resolveNativeCatalogProgram keeps order
and occurrences, max3 simultaneous resolutions; a missing selection rejects instead
of playing another song, cancel waits for settlement and does not publish an old queue.

Targeted19/5 passes in /tmp/soundsible-s2ae-extraction-ui.log. No Native
S2ae acceptance or end-to-end feed/pages yet. Pending: connect views, reversible
navigation, artists/albums/candidates, actions/jobs and HTTP/HTTPS
fixtures/instrumentation. Native57+restart2 of Appearance is still pending.


Pages base: nativeEntitySubject only accepts local artist/album routes,
keeps provider/local ID and credit; nativeProfileBookmark uses the resolved ID without
replacing an explicit one. createNativeEntityProfile cancels on edit/account/offline
and offers retry. ArtistDiscoveryView shares the discography layout with injected
links/rows; not yet connected to the web adapter or to Native. Four cases pass in
/tmp/soundsible-s2ae-profile-view-ui.log. This is not equivalent to real page walkthroughs.

## Screens connected; extended validation in progress

Discover shares SearchDiscoveryView with the web: feed, sections, artists and
albums, discreet status and songs. Android search explicitly includes
track/library_track/artist/album; the whole external catalog has not been implemented
(playlist included), so do not declare `all` search or full parity.
Artist/Album have reversible navigation, candidates, discography, native context
queue and song menus shared with Library. The actions of
bookmark, saving songs, acquisition and offline copy remain separate.
CollectionDownloadView and collectionState are shared with web, without their
playback stores. The Android controller uses confirmed Core jobs, abortable
scope, review/resume and cancel/retry; it rejects another provider/job and
old polling responses. The pending confirmation is closed when its
account is lost; saving songs does not acquire files or mark the entity.

Full UI:1516/187 pass (/tmp/soundsible-s2ae-full-ui.log). Six new cases
cover incorrect receipts, artist cancel, account change while confirming,
late poll, foreign resume and recovery from a temporary error. The current Core
fixture validates real profiles/discography against a synthetic provider: pytest1
passes (/tmp/soundsible-s2ae-provider-fixture.log). It does not demonstrate a live provider.

Running: full Chromium; then full WebKit sequentially. Development APK
prepared dirty, targeted integration CollectionProfileTest and
CatalogSearchTest HTTP/TLS in /tmp/soundsible-s2ae-profile-native.log. Do not accept
those walkthroughs until the results are inspected, and do not replace main57 yet.
End-to-end acquisition/review of collections and extended acceptance are still pending;
Settings/DJ/Live/Auto/signing/update are not complete. Continue.

First targeted integration:4 failures; not accepted. Two profiles failed because of a
fixture with a generic ID instead of deezer_artist_id/deezer_album_id. Two
CatalogSearch cases found a real regression: the shared menu omitted save/remove
when resolving a preview. Fixture fixed and checked by pytest1; the menu adds
catalog intents to the shared actions, with query/route scope.
Regression test passes; targeted18/2 passes. UI1516/187 passes again before
adding that test. CollectionDownloadView has2 cases for decisions/busy/cancel.
Full Chromium278/66 passes; WebKit in progress. New targeted integration in
/tmp/soundsible-s2ae-profile-native-fixed.log; sources/assets frozen during
its run. Do not attribute the first failed one to the product as validation.

Acquisition regression found: the cached preview of a resolution did not
check its YouTube identity against the new acquired snapshot. Core did
produce a real file/album/position; Play from the page kept sending the
preview. A new test reproduces the failure and passes after promoting by trackKeys,
without inferring ownership by title. Page holdings use that same resolver and
do not show "0 not found" when the job does not describe missing items.
Full UI1520/188 passes (/tmp/soundsible-s2ae-promotion-full-ui.log).
Prepared APK updated and6 HTTP/TLS cases in progress in
/tmp/soundsible-s2ae-promotion-native.log. The previous runs of6 cases
failed; do not present them as acceptance. Fixture cleanup restores new
saves even if the acquisition added a lib identity, keeping the
existing ones. Final shared Browser4: Chromium278/66, WebKit269/75 pass;
later fixes only affect modules of the Android entry/tests.
Additional pending item: end-to-end Core review and acquisition holdings without
a prior resolution must have their own acceptance; do not assume the cached path.

## Targeted acceptance of pages/save/acquire/navigate

Final result:6 HTTP/TLS tests pass,0 failures/errors/skipped, in
/tmp/soundsible-s2ae-final-directed-native.log. Dedicated XML in
android/build/integration-targeted/com.soundsible.android.CollectionProfileTest_com.soundsible.android.CatalogSearchTest/;
it does not replace main integration57/restart2. Normal APK/testAPK, JVM17 and lint
pass after removing the temporary CA. Development artifact prepared dirty;
not a release or acoustic acceptance.

Four collection walkthroughs test artist → real discography → album,
native play, explicit save without acquiring, Core/pipeline/file acquisition
with correct album and position, keeping the program during acquisition,
new Play order over the local source, going back through pages and query/scroll of the
Android container. Two CatalogSearch walkthroughs test save/remove, provider
failure/retry and accounts after those cases. Menus of resolved results
keep their own intents together with shared actions; holdings use
confirmed identities and the promoted cache. A long synthetic list allows real
scrolling; the tests select visible controls, not the hidden search.

Full UI1522/188 passes; pytest fixture1 passes. Shared Browser4 passes278/66 and
269/75. S2ae is still pending end-to-end Core review/cancel/retry and
acquisition without a prior resolution in the APK, in addition to the rest of the external catalog.
Do not treat six targeted cases as a full matrix. The following Settings have
plan S2AF; haptic adapter prepared separately, not yet connected to the APK.

## Core review in progress

CollectionReviewTest adds eight HTTP/TLS cases: version choice with low
confidence, explicit skip, cancellation during resolution and real acquisition failure
with retry. The fixture pytest walks real Core up to needs_review, decision,
resume and acquired file; it passes1 in /tmp/soundsible-s2ae-review-core-fixture.log.
The first Native run /tmp/soundsible-s2ae-review-native.log is NOT accepted:
it finds that acquiring without a previous Save/preview does not link the catalog with the
file. Core only extends identities of songs that are already saved. The UI
fix links identity_keys of completed/existing rows of a confirmed job to the
matched_track_id present in the library; it does not create saves or use titles.
Targeted test of navigation, removal and account change included. Retry
incorrectly expected failed at job level; Core uses partial for failed rows.
Fix that expectation and repeat the walkthrough before accepting the block.
Native sources/fixtures/assets stay frozen until this run finishes.

Accepted repeat: /tmp/soundsible-s2ae-review-links-native.log ends with0;
16 tests, zero failures/errors/skips (14 for review/pages/search and2 feedback).
Own XML in integration-targeted/com.soundsible.android.CollectionReviewTest_com.soundsible.android.CollectionProfileTest_com.soundsi/.
Normal APK/test APK/JVM17/lint pass and temporary CA removed. Review chosen,
skipped, cancelled and retried walk real Core HTTP/TLS; acquiring without a previous
save ends in local Play. Link by identity_keys/matched_track_id confirmed,
source removal and account change covered in UI. UI1526/189 before Learning;
later Learning/diagnostics are validated separately and were not in that APK.
The first failed run remains a diagnosis, not acceptance. The previous clean main57/restart2
remains in force until the extended one is repeated from a clean commit.
