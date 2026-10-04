# Android client

Native client for your own Soundsible server. See [`docs/ANDROID.md`](../docs/ANDROID.md)
for the installing/pairing guide, signing honesty and verification status.

## Quick build

```bash
./scripts/build_android_apk.sh
ls -lh app/build/outputs/apk/release/app-release.apk
```

## Develop

```bash
./gradlew :app:testDebugUnitTest   # pure-logic unit tests
./gradlew :app:assembleRelease     # signed APK (local debug key)
./gradlew :app:installDebug        # install on an attached device/emulator
```

`versionName` is a copy of `shared/version.py`; CI enforces it with
`scripts/version_sync.py --check`. Never bump it by hand.
