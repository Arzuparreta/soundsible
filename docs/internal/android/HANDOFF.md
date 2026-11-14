# Android port handoff

Current state and way of working. What has been superseded is in
[HANDOFF_HISTORY](HANDOFF_HISTORY.md); the results of each block, in
[EVIDENCE](EVIDENCE.md). Plan and matrix: [PORT_PLAN](PORT_PLAN.md); publication:
[RELEASE_GATES](RELEASE_GATES.md).

## Current decisions

- Parity integrated into `main` through PR #300, with full checks passed.
  Distribution integrated through PR #304 and alpha published. On 2026-10-07 the
  user authorized a new key and merge/publication after all gates were closed.
  Do not publish if the signed APK or the final acceptance fail.
- 2026-10-09: the APK ships in the `v*` release of each version, with the other
  artifacts, not as a separate `android-alpha/*` prerelease (user decision;
  see RELEASE_GATES point 7). The file name already says "alpha".
- Parity = **feature** parity with the webapp (alpha). If the web uses a workaround
  because of a browser limitation, Android does it in the best native way.
- Shared Solid UI with native adapters. The web stores are not imported in
  Android (they own the web audio): the pure logic is extracted to shared `lib/` or `components/`
  and Android provides a native controller. iOS is separate Swift; unverified PAL
  notices are kept.
- Offline B: explicit copies of acquired music, "Available offline" in
  three-dot menus; no implicit acquisition or auto-eviction.
- Pairing QR code = full session of the account that shows it (S2av).
- The maintainer does not have an Android device; do not ask them to connect one to
  close the delivery. The community performs the physical acceptance of listening,
  Bluetooth and car following [ALPHA](../../ANDROID_ALPHA.md#community-testing).
  AVD/CI do not replace that evidence. It is a beta requirement, not an alpha requirement.

## How work is done (updated 2026-10-06 to go faster without losing quality)

1. **Inventory first, not by discovery.** The list of gaps below comes
   from comparing which texts/actions the web reaches and Android does not
   (`python3 scripts/android_parity_inventory.py`: import reachability from
   `main.tsx` versus `mobile/main.tsx`). The list is closed; no new gaps are opened without checking against it.
2. **Blocks per area, not micro-slices.** Several gaps of the same screen go in
   a single block, with a single commit, one native run and one row in EVIDENCE.
3. **Test pyramid.** Logic and race guards → Vitest/JVM (fast). Native
   test only for what crosses the native boundary or depends on the real Core, and
   **HTTP only** unless the block touches transport (EngineConnection, TLS,
   sockets, WebRTC/relay, streaming/Range). Full TLS runs in the final
   regression, which is the one that gives the guarantee.
4. **Regression targeted by impact radius**: the native classes that use the touched
   code, in a single run. Full main suite + browser4 at the end, once.
5. **Minimal documentation**: one row in EVIDENCE per block (date, commit, tests,
   result, log). `SLICE_*.md` only if there is a design decision to explain.
   No source hashes or JSON per block: the commit already fixes the state.
6. Each validated block ends in commit + push. Gradle only `:app:*`; never
   `npm run build` in `ui_web`.

## Pending parity gaps (inventory 2026-10-06)

- [x] S2aw Song menu: go to artist/album, "Not interested" with reason, play on another device.
- [x] Podcasts: Top/recommended section with subscribe and "Not interested"; "downloaded only" filter in the show.
- [x] Library: sort (A–Z, recent, favourites first), downloaded filter, albums by genre/year.
- [x] Queue: requests after the current song as in the web, clear requests; notice to resume a session from another device (handoff through Core).
- [x] Search: downloading from the catalog goes through the engine check (`/api/catalog/save`) and asks "Choose version" if unsure.
- [x] DJ: "Change session" from a collection (the session becomes that single source).
- [x] Settings: settings search (web index filtered to what Android draws).
- [—] Mute: not ported. On Android, volume and mute belong to the system (keys, controls); the web button
      exists because the browser does not have them.
- [x] DJ "Request all": collection action → Core batch; groups in `autoRoute.requestGroup`,
      removed only when changing session, with loose request and playback kept.
      Profile/direction/add sources keep the groups.
- [x] POST_NOTIFICATIONS: declared; the first offline preparation asks for permission on Android 13+.
      Granting/denying continues the copy; there is no further prompting after denying.
- [→] Public bridge/App Links: moved to RELEASE_GATES (point 9). Needs a permanent key, `assetlinks.json`
      at the root of `Arzuparreta.github.io` and a public APK; the public bridge offers Android opening with the shared capsule. Invitations
      live on each server's domain (not verifiable): their path is SEND, already accepted (S2at).
- [x] DJ negatives: the persistent stream failure (503 on all, both decks) is already in `DjNetworkTest`:
      visible error without hanging, same occurrence and recovery with explicit retry.
- [x] Auto negatives: the car socket stayed dead after retries were exhausted (real failure, fixed with
      a 30 s cooldown like S2aq). Labels of the active programme: `CarDjTest`/`CarEventsTest`.
- [x] Local Core regression (1792), UI (1660), full browser4 and offline/Live restart (4 phases).
- [x] Final main suite in CI: the full local run (211 cases) found fixture
      and shared clock failures; fixed and revalidated by impact radius (EVIDENCE).
      CI of PR #304 and of the published main (88033c20) passed: build/JVM/lint and four shards.
- [x] [PR #300](https://github.com/Arzuparreta/soundsible/pull/300) integrated with `impact:minor`,
      `origin/main` base verified and checks passed.
      `Co-authored-by` credit to emrothenberg in the implementation commit and in the PR.
- [x] Permanent key created outside Git, backup on an independent disk tested;
      secrets in the `android-release` environment, restricted to `main` and, since
      2026-10-09, to the `v*` tags, where `release.yml` builds the APK of each version.
- [x] Distribution implemented and accepted locally: signed release APK,
      update keeping account/settings/offline, installation negatives,
      offline startup/PCM and cold/warm App Links. Evidence in EVIDENCE.
- [x] Publication: [first public alpha](https://arzuparreta.github.io/soundsible.github.io/es/start/#android-title).
      Release workflow 37623396866 passed on main `88033c20`; the exact APK
      was installed and accepted before publishing. Independent `android-alpha/*` channel,
      prerelease, global latest kept. Public download on the ES/EN website.
      Update from that public APK rehearsed locally with a private candidate;
      account/settings/offline copies kept. Evidence in EVIDENCE.
- [x] Domain association published through PR Arzuparreta.github.io #11;
      HTTPS 200/application-json response checked with the correct certificate.

## Commands

- JDK21 `/home/arsu/.cache/soundsible/android-toolchain/jdk`, SDK
  `/home/arsu/.cache/soundsible/android-toolchain/sdk`: export `JAVA_HOME`,
  `ANDROID_HOME` and their `bin` in `PATH` for `prepare` and `integration`.
- Local AVD `soundsible-alpha-api36`: `emulator -avd soundsible-alpha-api36 -no-window -no-audio -no-boot-anim -port 5554`.
- `.venv/bin/python scripts/android.py prepare` and then
  `env 'ORG_GRADLE_PROJECT_android.testInstrumentationRunnerArguments.class=com.soundsible.android.A,com.soundsible.android.B' .venv/bin/python scripts/android.py integration`
  (zsh does not accept the name with dots without `env`). The runner starts the fixtures
  5097/5098/5099 (and the Live relay if needed) and at the end builds the normal APK,
  JVM and lint. JUnit results in `android/app/build/outputs/androidTest-results`.
- UI: `cd ui_web && npm test && npm run typecheck`. Core: `PYTHONPATH=. .venv/bin/pytest -q tests/…`.
- Disposable fixtures: never the real engine or accounts. A real library wipe
  in the fixture would remove shared audio: do not run it.
- Shard failures and Live silence: artifacts, signals and trace reading in
  [CI_DIAGNOSTICS](CI_DIAGNOSTICS.md). A passing retry does not identify the cause.
