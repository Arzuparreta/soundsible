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

S1 now connects to an engine with a native account cookie (Keystore protected),
REST/artwork/Socket.IO and a read-only shared Solid catalogue. Public cleartext is
blocked; only the native private routing alias has an OS exception. See
`docs/android/ARCHITECTURE.md`. With an AVD and Python engine dependencies installed,
`python scripts/android.py integration` owns three disposable real-engine fixtures, including verified TLS. It removes temporary test trust and rebuilds the normal APK afterward.
S2a adds local-file NORMAL playback in a MediaLibraryService, native controls,
Range/seek, focus and Activity-independent state. Full UI/modes, process-death
resumption and public distribution remain pending; continue with `SLICE_2.md`.
