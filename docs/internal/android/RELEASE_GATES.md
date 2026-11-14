# Android distribution and publication requirements

## Current development

`android-build.yml` only produces debug artifacts and evidence. It does not create GitHub
Releases, tags, a signed distribution APK, an updater or a Google
Play listing. Do not change this as a side effect of completing connection or audio.
The `.dev` debug package avoids replacing the public installation.

The public can access artifacts of a public repository; their development
label and expiry are not equivalent to privacy. The tests use fixtures and
dedicated accounts, never music, passwords or logs of a personal instance.
The debug signature does not establish a permanent identity: do not guarantee updates
between runners that generate different keys. Public updates must be
checked with a permanent key.

## Manual review before publication

The parity delivery (PR #300) was reviewed and integrated into `main` on
2026-10-07. That day the user authorized preparing the distribution, creating a permanent
key and completing merge/publication when all gates are green.
This authorization replaces the wait for manual review of 2026-10-05 for
this release work; it does not allow skipping checks or publishing debug artifacts.

Since 2026-10-09 the APK ships in the release of each version (`v*`), together with
server, desktop and iOS: `release.yml` calls `android-release.yml` on the tag,
in the restricted `android-release` environment (`main` branch and `v*` tags), and attaches
what that workflow prepares. Run manually on `main`, it is a rehearsal that does not
publish. The `scripts/android_release.py` tooling derives the `versionCode` from the
version, validates the APK, requires update/offline/App Links acceptance and
waits for the CI of the tagged commit to be green before delivering it. The public
signing reference is [SIGNING.json](SIGNING.json); capabilities and limits:
[CAPABILITIES.json](CAPABILITIES.json). Instructions: [ALPHA](../../ANDROID_ALPHA.md).

## Public state (2026-10-07)

The [first alpha](https://arzuparreta.github.io/soundsible.github.io/es/start/#android-title)
is published as an independent prerelease. Full CI and acceptance of its exact
APK passed; global latest kept. Installation and limits: [ALPHA](../../ANDROID_ALPHA.md).
Acceptance on phone, Bluetooth and car is still pending for beta.

## First alpha

Before enabling the publication workflow, the following must be met:

1. Complete parity matrix for the phone, DJ, Live and Android Auto, with tests
   of real actions and evidence for each row, not only screens/compilation.
2. [Offline B](OFFLINE_DECISION.md) approved by the user: explicit copies of
   acquired music, "Available offline" inside menus. Its implementation
   and acceptance must be complete; approval is not equivalent to validation.
3. Automated functional evidence of the full port and declared physical
   limits. Do not confuse tested contracts/media service with real
   listening or car acceptance; the full physical gates belong to beta.
4. Permanent signing key with backup, identity `com.soundsible.android`,
   secrets restricted to the publication environment and the SHA-256 of the certificate
   documented. No secret is used in PRs from forks or in debug builds.
5. Release APK installed and updated over a previous one signed with the
   same key; keep account/configuration and approved data, without destructive
   migration. Test rejected downgrade and corrupt APK/different signature.
   From the second alpha onwards, install the latest downloaded public APK without
   rebuilding it; only the first publication allows a synthetic base. The
   acceptance receipt records which one was used.
   Prepare that base with its own `upgrade-seed-androidTest.apk`, kept
   with a checksum in its assets, and verify its SDKs against its original metadata.
   After updating, replace the harness with the candidate's to verify it.
6. Version coming from `shared/version.py` and `scripts/version_sync.py`;
   monotonic `versionCode`, derived from the version and validated against the last
   published one.
7. ~~Android publication as an independent pre-release.~~ Replaced on
   2026-10-09 by user decision: all artifacts of a version ship
   together in its `v*` release; the APK keeps "alpha" in the name, which is enough to
   indicate its maturity. The `versionCode` is derived from the version
   (`MMMmmpp99`, `-rc.N` instead of `99`), above the codes used by the
   `android-alpha/*` channel, whose prereleases still serve as predecessors
   for the update test.
8. Signed APK, checksum, clean build metadata, documented permissions,
   installation/update notes and verified limits. The required capabilities
   manifest and the offline decision must be publication gates.

9. https links to the app (App Links): `assetlinks.json` with the SHA-256 of the permanent key at
   `https://Arzuparreta.github.io/.well-known/assetlinks.json` (the domain root, not the site
   subdirectory), `autoVerify` intent-filter for the `/soundsible.github.io/open/` path and, in the bridge, a link to the
   app only when a public APK exists. Invitations use each server's domain and continue through SEND.

Do not write a product version by hand, not even for an example of an Android
tag. The alpha/beta maturity name does not create another commercial version.

## Beta and stable

The community provides the physical acceptance: the maintainer does not have Android.
The guide and the results format are in
[ALPHA](../../ANDROID_ALPHA.md#community-testing). Also record
the correct results and the untested cases; do not close a gate because of an absence
of failure reports.

The beta requires repeated physical acceptance of listening, background, focus,
Bluetooth/controls, Android Auto, changing networks and updates keeping the
profile. The alpha does not promise that all manufacturer/car combinations are
tested. For stable, close the regressions of the beta cycle, published compatibility
and recovery/diagnostics. Keep evidence per device/OS/WebView, not a
single "Android works".

## Updates and official sources

Sharing Solid updates the **next build**, not the installed phone.
Manual APK distribution first; the design of update notice/download/verification and
installation will be a separate slice. Android normally asks for
consent for external installation; do not promise silent installation.

- [APK signing and identity continuity](https://developer.android.com/studio/publish/app-signing)
- [GitHub pre-releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
- [Media3 background playback](https://developer.android.com/media/media3/session/background-playback)
- [Android Auto media](https://developer.android.com/training/cars/media)
- [DHU: requires an Android Auto device](https://developer.android.com/training/cars/testing/dhu)
- [Lab devices](https://firebase.google.com/docs/test-lab)

A phone farm allows extending tests, but does not replace listening in
the user's car/Bluetooth. Coordinate hardware contributions without claiming
that CI has closed those tests.
