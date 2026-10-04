# Soundsible for Android

Native client for your own Soundsible server. Mirrors the iOS app's contract
(`ios/SoundsibleKit`): pairing, `/api/car/*` browse, authenticated streaming,
playback-state publishing, queue semantics and offline policy.

> **Not yet installed or run on a device.** CI builds the APK and runs the
> unit tests, but neither proves installation, pairing, playback, background
> audio, offline listening, Android Auto or car controls. Like the iOS guide,
> the feature descriptions below describe the intended behaviour of the code,
> not a verified user experience. First installation and physical-device
> validation are still required.

## Installing (sideload)

1. Build a signed APK (below) or take one from a release.
2. Copy it to the phone and open it; allow *Install unknown apps* for the
   source you used.
3. Open Soundsible and pair with your server (below).

The APK is signed with a **local throwaway debug key**, not a Play upload
key. It is installable and `apksigner`-verifiable, but carries no release
identity -- see *Signing* below. There is no Play Store listing: guideline
equivalents aside, this project distributes Android exactly like iOS
sideloading (see `docs/IOS.md`).

## Pairing

On your Soundsible, open **Settings -> Pair a device** and leave the QR sheet
on screen. It is what turns on auto-confirm, and auto-confirm is what lets the
phone finish pairing on its own. In the app, enter the server URL and the
pairing code.

For a headless server, use the token form and paste a paired-device token with
the `library:read` scope. The token is verified before it is stored, so a typo
fails on the pairing screen instead of on the library screen.

The credential lives in EncryptedSharedPreferences and is only ever sent to
your own server.

## What the app does

| Area | Status |
| ---- | ------ |
| Pair with code / token, verify, unpair | Implemented in code; unverified on device |
| Browse `/api/car/home` + `/api/car/items/<id>` | Implemented in code; unverified |
| Play `stream_url` through Media3 ExoPlayer, background service | Implemented in code; unverified |
| Publish `PUT /api/playback/state`, register `device_type: "android"` | Implemented in code; unverified |
| Queue (repeat/shuffle/up-next) and offline pin/budget policy | Implemented; covered by unit tests |
| Android Auto browse/play via MediaLibraryService | Implemented in code; unverified, needs a car or Desktop Head Unit to prove |
| QR-code scanning | Not in v1; manual entry is the whole flow |
| Offline downloads in the UI | Policy + downloader exist; not yet wired to a downloads screen |

## Building

Prerequisites: JDK 17+, the Android SDK (`compileSdk 34`, build-tools 35),
and Gradle 8.7 (the wrapper downloads it on first run).

```bash
# One step: generate the local debug key (if missing), run unit tests,
# build the signed release APK and verify it.
./scripts/build_android_apk.sh

# The artifact:
ls -lh android/app/build/outputs/apk/release/app-release.apk
```

What the script does:

1. `keytool -genkeypair` a throwaway key at `android/keystores/debug.keystore`
   (gitignored) if it is not there already.
2. `./gradlew :app:testDebugUnitTest` -- the pure-logic suite that mirrors
   the Swift kit tests (queue, offline policy, pairing payload, client).
3. `./gradlew :app:assembleRelease`, signed by the local key.
4. `apksigner verify --print-certs` on the result.

Useful direct invocations:

```bash
cd android
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleRelease
```

## Signing

`app/build.gradle` signs both `debug` and `release` with
`android/keystores/debug.keystore` (alias `androiddebugkey`, the conventional
debug passwords). That makes the APK installable and lets anyone reproduce the
exact artifact from source, but it must not be described or published as a
Play release: there is no upload key, no Play App Signing, and no identity
behind the certificate. A real Play listing needs a guarded upload key and is
not planned (see *Why not the Play Store* in the iOS guide for the reasoning
applied to stores in general).

## Versioning

`versionName` is a copy of `shared/version.py`, kept in step by
`scripts/version_sync.py --check` in CI. Never bump it by hand.

## Layout

| Path | What it is |
| ---- | ---------- |
| `android/app/src/main/java/com/soundsible/player/data/` | `CarItem`, `ServerConnection`, `PairingPayload` -- mirrors `Models.swift` etc. |
| `.../logic/` | `PlayQueue`, `OfflineLibrary` -- pure policy, unit-tested |
| `.../net/` | `SoundsibleClient`, `PairingCoordinator`, `HttpTransport` -- no HTTP framework |
| `.../store/` | Encrypted `TokenStore`, stable `DeviceIdentity` |
| `.../ui/` | `MainActivity`, `PairingActivity`, `BrowseActivity`, `NowPlayingActivity` |
| `.../playback/` | `PlaybackService` (Media3 MediaLibraryService), `QueueHolder`, `OfflineStore` |
| `.../src/test/` | JUnit suite mirroring `SoundsibleKitTests` |

## What CI proves

`.github/workflows/android.yml` runs `version_sync.py --check`, the unit
tests and `assembleRelease` on every push/PR touching `android/**`, then
verifies the APK signature. It does not install, pair, play, or drive the app.

## What CI cannot prove

First installation on a real phone, pairing against a real server, audible
playback, background/lock-screen behaviour, offline listening, Android Auto
rendering and car controls. Until a human runs those, this client stays
pre-beta and must not be announced as supported.
