# Android development shell

Start with [the Android guide](../docs/ANDROID.md) and
[the contributor handoff](../docs/android/HANDOFF.md).

The Gradle project is based on the pinned Capacitor CLI template. Commit sources,
resources and Wrapper; never generated web assets, plugin settings, SDK paths,
Gradle caches or credentials. Run `python scripts/android.py prepare` from the
repository root before opening Android Studio. `build-info.json` is generated
from the central Soundsible version and git state; Gradle deliberately fails if
it has not been prepared.

Development uses the `.dev` application ID. There is no release signing or
publication configuration yet. Compiling or starting this shell does not prove
music playback, background operation, DJ, Live, offline or Android Auto.
