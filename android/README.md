# Android development shell

Start with [the Android guide](../docs/ANDROID.md) and
[the contributor handoff](../docs/android/HANDOFF.md).

The Gradle project is based on the pinned Capacitor CLI template. Commit sources,
resources and Wrapper; never generated web assets, plugin settings, SDK paths,
Gradle caches or credentials. Run `python scripts/android.py prepare` from the
repository root before opening Android Studio. `build-info.json` is generated
from the central Soundsible version and git state; Gradle deliberately fails if
it has not been prepared.

Development uses the `.dev` application ID. The permanent public identity is
`com.soundsible.android`; release signing reads external credentials only.
The independent `android-release.yml` workflow is restricted to `main` and the
`android-release` environment. See [release gates](../docs/android/RELEASE_GATES.md)
and [alpha installation](../docs/android/ALPHA.md).

Phone, NORMAL/DJ, Live, Android Auto and explicit offline copies are integrated.
Automated service/PCM evidence does not establish physical phone/Bluetooth/car
acceptance. `python scripts/android.py integration` owns disposable real-engine
fixtures, including verified TLS; fixture trust exists only in temporary debug
resources, never in the signed distribution.
