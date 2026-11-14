# Soundsible Android alpha

Android client for your Soundsible server: library, search/acquisition,
playlists, podcasts, Radio/Autoplay, NORMAL, DJ with native mixing, Live,
Android Auto and explicit offline copies of music.

## Install and update

Download `Soundsible-Android-alpha.apk` from the version's release and verify
`SHA256SUMS-android.txt` (alphas up to 0.21.1 called it `SHA256SUMS`). Android asks
you to allow installation from your browser or file manager. Install over
an earlier alpha to keep your account, settings and offline copies. Do not
uninstall to update. Soundsible Dev is a separate app: its data is not
migrated to the public app. Updates are manual.

`upgrade-seed-androidTest.apk` is auxiliary evidence for the automated upgrade
tests; install only `Soundsible-Android-alpha.apk`.

Connect using your server's address and your account, or scan the QR code from
Settings → Devices in an existing session. The QR code starts a full session
for that account and can be revoked from Devices. To listen offline,
choose “Available offline” in the menu of acquired music and check that
the copies are ready before disconnecting. Logging out removes those copies.

## Compatibility and limits

Technical minimum: Android API 24 and Chrome WebView 120. The initial evidence is
from an API 36 emulator; older versions are not presented as verified.
Services, transport, PCM, controls, restarts and updates are validated.
Physical listening, Bluetooth and specific cars remain pending for beta.
The fixtures do not test all public providers. A Soundsible server is
required; there is no server embedded in the phone.

## Permissions

Internet connects to the server and network-state access detects connectivity;
media services and wake lock allow audio
in the background. A dataSync service prepares the requested copies. On Android
13+ notification permission is requested when the first copy is prepared: denying it
does not block copies. The camera is only requested to scan the QR code. Live publishes
the native programme and does not use the microphone. No general file
permissions are requested: copies are stored in the app's private storage.

To report a bug, include version/build/commit from `android-release.json`,
device model, Android and WebView versions, steps, and whether it happens online or offline. Do not include
passwords, QR codes, cookies or private music.


## Community testing

Acceptance on real devices comes from the community: the maintainer
does not own an Android device. Help by testing the alpha on your phone and publishing
results, including successful ones, in [GitHub Issues](https://github.com/Arzuparreta/soundsible/issues).
These tests collect the evidence needed for beta. Mark as “Not tested”
what you cannot check; you do not need a car or every accessory.

| Check | Expected result |
| --- | --- |
| NORMAL, DJ and Live listening | Correct audio and controls, no unexpected gaps; received Live audio is audible |
| Live publishing from Android to a remote listener | The listener receives NORMAL and DJ audio, including transitions; the publisher's local volume does not change the broadcast |
| Screen off and another app | The programme continues and media controls work |
| Call or audio interruption | Pauses or ducks according to audio focus and recovers without duplicate audio |
| Headphones and Bluetooth | Correct controls and no unexpected speaker playback on disconnection |
| Wi-Fi, mobile data and network loss | Visible error state and recovery; no hang |
| Ready copies, airplane mode and restart | Prepared music plays offline after reopening |
| Android Auto, if available | Correct library, selection, controls and metadata; test with the car parked |
| Upgrade when another alpha is available | Installing over it preserves account, settings and copies |

Copy the device details once and repeat the check block for each
check, including untested ones. Report NORMAL, DJ, Live listening and Live publishing separately, and separate the different
accessories or networks if their results differ. Add reproducible steps for failures.

```text
Build/commit (android-release.json):
Phone:
Android and WebView:
Soundsible server build:
Headphones/Bluetooth/car used:

Repeat for each check:
Check and mode:
Result: OK | Failed | Not tested
Steps and duration:
Expected and observed:
Network: Wi-Fi / mobile data / offline
```

Do not share credentials, session QR codes, cookies or private music.
