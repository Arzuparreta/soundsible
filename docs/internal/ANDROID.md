# Soundsible for Android: port development

**Status: alpha Android client with independent APK distribution.**
Public downloads only appear after the channel gates pass;
the alpha APK is attached to each GitHub release, together with the other platforms.
The APK connects to your Soundsible server and uses your account. It includes library,
search and acquisition, playlists/favourites/metadata, podcasts, Radio/Autoplay,
NORMAL queue, DJ with native mixing and Live (listening and broadcasting), as well as Android
Auto and explicit offline copies. The Solid interface ships in the APK; audio
is run by the native services, without loading the Web Audio runtime.

The automated validation and its limits are in [EVIDENCE](android/EVIDENCE.md).
The emulator verifies services, PCM, transport and controls; it does not certify listening,
Bluetooth or operation in a physical car. Permanent signing, updates,
verified App Links and publication remain subject to
[RELEASE_GATES](android/RELEASE_GATES.md). The user authorized preparing and publishing the alpha on 2026-10-07 after the gates were closed.
The public installation and its limits are described in [ALPHA](../ANDROID_ALPHA.md).

## Resuming the work

Read [HANDOFF](android/HANDOFF.md) for the current state and
[EVIDENCE](android/EVIDENCE.md) for the tests. The
[matrix](android/PORT_PLAN.md) keeps traceability per capability; the
`SLICE_*` documents and the history describe earlier cuts, not the current state.
The current offline decision is [Offline B](android/OFFLINE_DECISION.md).

## Architecture

The interface comes from `ui_web/`, with a small Android entry point, Capacitor and a
native Kotlin layer in `android/`. The assets ship inside the APK; the server's
web app is not loaded. The engine is still the user's Soundsible instance:
neither Python nor a server is included on the phone.

Sharing Solid lets UI changes go into the next build; it does not
turn Web Audio into an Android player. Background audio, native mixing,
Android Auto and Live broadcasting require a specific implementation.

The current iOS client is independent SwiftUI/Swift. It does not share the
Solid screens and its behaviour on a device remains [unverified](../IOS.md).

## Linux environment

- Node 22 or later, npm, Python 3.10+, git.
- **JDK 21**. Export `JAVA_HOME` and put its `bin` before the system JDK.
- Android SDK: command-line tools, platform-tools, platform API 37.0 (compileSdk)
  and build-tools 36.0.0. targetSdk stays at 36. Android Studio is optional for the
  terminal commands.
- For the emulator: accessible KVM, the emulator package and the image
  `system-images;android-36;google_apis;x86_64`.

Install the tools following the
[official documentation](https://capacitorjs.com/docs/getting-started/environment-setup).
With the SDK already installed, configure its real paths (do not copy paths from another
machine):

```sh
export ANDROID_HOME="$HOME/Android/Sdk"
export JAVA_HOME=/path/to/jdk-21
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
sdkmanager 'platform-tools' 'platforms;android-37.0' 'build-tools;36.0.0' 'emulator' 'system-images;android-36;google_apis;x86_64'
npm ci --prefix ui_web
python scripts/android.py doctor
```

Capacitor core/CLI/Android are pinned together; the Gradle Wrapper includes a
checksum. The build uses AGP 9 with its built-in Kotlin (without the
`org.jetbrains.kotlin.android` plugin). The project minimum is API 24 and WebView Chrome 120. **That is a
technical minimum, not evidence that it works on old Android versions.** The initial
matrix uses API 36; extending versions requires tests, especially of WebView.

## Prepare, build and install

```sh
python scripts/android.py prepare
python scripts/android.py build
python scripts/android.py install --serial emulator-5554
python scripts/android.py smoke --serial emulator-5554
```

`prepare` generates metadata by reading the central version, runs Vite with the
Android configuration and syncs Capacitor. `build` adds the debug APK, the
instrumentation APK and lint. **Do not run `npm run build` locally.**
The Android output is `android/web-dist/`; the engine bundle `ui_web/dist/`
is not written. The generated assets and the local SDK paths are not committed.

The development application is `com.soundsible.android.dev`, labelled
**Soundsible Dev**. The future public application will be `com.soundsible.android`.
The APK is placed in `android/app/build/outputs/apk/debug/app-debug.apk`.
To open the project with Android Studio, import `android/` after
`prepare`. Prepare again after changing sources before building from the IDE.

`build-info.json` records version, commit, dirty tree and development counter.
A dirty tree must never be presented as an exact build of a commit.
`SOUNDSIBLE_ANDROID_BUILD_NUMBER` is a development build counter, not a
release number. Its local default value is 1; CI uses its run number.

## Connecting the APK

Enter the origin, without `/player`, path, user, password or query:
`http://10.0.2.2:5005` for the host's engine from the AVD; a private IP/LAN DNS
or Tailscale for your own network; `https://musica.example.org` for remote access.
The port depends on the instance. `localhost` on the phone is Android
itself, not the host. An HTTP hostname must resolve only to private addresses;
the check is repeated when the connection is established. HTTPS uses Android's normal
trust, without accepting invalid certificates or following authenticated redirects.

You sign in with the engine account (or automatically on a single
instance without a password). The password is only used for that login. The session
cookie stays in Kotlin, encrypted with Keystore; it is not in localStorage, URLs,
WebView cookies or metadata. The permissions are still those of that account.
Signing out deletes the local secret even if the server does not respond;
**Refresh** reloads the library and reopens disconnected events.
Do not change HTTP to HTTPS in a URL unless the server offers TLS.


## Emulator and tests

```sh
printf 'no\n' | avdmanager create avd --name soundsible-api36 --package 'system-images;android-36;google_apis;x86_64'
"$ANDROID_HOME/emulator/emulator" -avd soundsible-api36 -no-snapshot -no-window -no-audio -gpu swiftshader_indirect
```

In another terminal, wait for the device to finish booting. To check
that the screen and the translation are loaded from the APK:

```sh
adb wait-for-device
adb shell svc wifi disable
adb shell svc data disable
python scripts/android.py smoke
```

For the real integration with three disposable engines (accounts, passwordless and HTTPS):

```sh
# Use the Python that has the engine dependencies, for example .venv/bin/python.
python -m pip install -r requirements.txt
# First update the Solid assets and the APK if the sources have changed.
python scripts/android.py build
python scripts/android.py integration --serial emulator-5554
```

The helper only accepts an emulator, enables its Wi-Fi, requires ports 5097/5098/5099 to be free,
creates new temporary directories, starts the real Flask/Socket.IO routes and
closes the processes when finished. It never uses the personal engine or its directories.
For TLS it generates an ephemeral CA/key, verifies chain and hostname, installs the
trust only in temporary debug resources, runs the APK and deletes those
resources and the keys. Afterwards it rebuilds the normal APK without that CA; release does not
receive TLS exceptions. Certificate verification is not disabled.
The synthetic accounts are `owner`/`member`, password `android-test`.
`smoke` skips the tests that require a fixture; `integration` runs the full main
suite and the offline and Live restart protocols.
The `/__fixture/*` and `/api/android-fixture/*` controls exist only in the
`scripts/android_fixture.py` process; they are never registered in the production engine.


The test opens the real APK, waits for Solid to start, checks `App.getInfo`, version,
identity, commit, absence of API/socket requests and of a controlling service worker,
and reloads the Spanish translation without a connection. It is evidence of the **local shell**,
not of offline music. Keep the instrumentation, lint, screenshot and
logcat results together with the build metadata.

For shared client changes, also run `cd ui_web && npm test`
and the four full browser profiles according to `AGENTS.md`; mobile Chromium
does not replace WebView or WebKit. Do not restart or use the library of the personal
engine for these tests.

## GitHub and limits

The **Android development** workflow builds and tests the relevant changes and
allows manual runs. The instrumented suite is split across 4 emulators in parallel
(`python scripts/android.py integration --shard 0/4`; shard 0 also runs
the offline startup and the restart protocols) and a separate job builds, runs
lint and unit tests. Its artifacts expire after 14 days. In a public
repository the artifacts may be downloadable: they are development builds, not a
published alpha or an update channel. The workflow only has read access,
does not use public signing keys and does not publish releases or tags.

Public distribution uses the signed APK attached to each GitHub release; it does not require Google
Play. There will be no silent update merely because code is shared.
See [the publication requirements](android/RELEASE_GATES.md).


## Using and reviewing the alpha

1. For the public alpha, follow [ALPHA](../ANDROID_ALPHA.md) and install the signed APK
   from the version's release. The debug APK and its `.dev` package are still for
   development and do not migrate their data to the public identity.
2. Connect with address and password, or scan the QR code that another session of your
   account shows in Settings → Devices. You can also type its code.
   The QR code starts a full session of that account, revocable from Devices.
3. Play songs or collections. "Add to queue" places the requests
   after the current song; "Clear requests" keeps the album/playlist and the
   generated items. You can resume a session from another device through handoff.
4. Start DJ from a song/collection. "Add to session" requests the collection
   as a group; "Change session" removes those groups and keeps loose requests.
   The profile/direction/source settings keep the group. The queue accepts
   up to 1,000 occurrences; the bridge payload and the responses are bounded.
   If the musical placement fails, the requests stay in the queue and the state
   shows the fallback; songs are not discarded because of a planner failure.
5. Prepare acquired music from "Available offline" in its menu. On
   Android 13+ the notification permission is requested the first time you prepare,
   to show the progress in the background. Denying it does not prevent the copies or
   playback and does not cause new prompts. It can be changed later in
   Android Settings → Apps → Soundsible → Notifications. The microphone is not used;
   the camera is only requested when scanning a QR code.
6. Before disconnecting the network, check that the copies are listed as ready in
   offline management. Partial copies do not count; offline artwork uses a
   placeholder. Signing out deletes the profile's copies.

Links received through Share (SEND) require an explicit action before
changing account/server. Automatic opening of https links uses the permanent signature and domain
association verified during the acceptance of each public APK. Listening volume
is controlled with Android and does not change the programme broadcast through Live.

## Contributions

The work of [emrothenberg in PR #298](https://github.com/Arzuparreta/soundsible/pull/298)
contributed the Android client proposal and observations incorporated into this port,
including the notification permission for offline copies. They are credited
as co-author in the closing commit and in the PR. This client keeps the engine
on the user's server; the embedded server of that proposal is not part
of this delivery.
