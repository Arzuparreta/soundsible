# Soundsible for iOS

A native client for your own Soundsible. It exists for the three things Safari
will not let a web player do on an iPhone:

- **Keep playing when the screen locks** or you switch app.
- **Download music to the phone** and play it with no server in reach.
- **Behave properly in a car** — title, artist, artwork, a progress bar that
  moves, and buttons on the wheel that do what they say.

It is not on the App Store, and that is deliberate. See
[Why not the App Store](#why-not-the-app-store).

---

## Installing

You need an iPhone or iPad on **iOS 26 or newer** and a sideloading app.
**[SideStore](https://sidestore.io)** is the recommended one: after a one-time
setup it re-signs your apps on the phone itself, with no computer.

1. Install SideStore following its own instructions.
2. Add the Soundsible source:

   ```text
   https://github.com/Arzuparreta/soundsible/releases/latest/download/apps.json
   ```

   That URL always resolves to the newest release, so the app updates itself
   from it.

3. Install Soundsible from that source.
4. Open it and pair with your server (below).

> **The seven-day thing.** A free Apple ID can sign at most **3** sideloaded
> apps, and the signature lasts **7 days**. SideStore renews it in the
> background on the phone, and pairing it with **LiveContainer** works around
> the three-app cap. Both are Apple's limits on sideloading, not something
> Soundsible can lift.

You can also grab the `.ipa` straight from a
[release](https://github.com/Arzuparreta/soundsible/releases) and install it with
AltStore, SideStore or Sideloadly.

## Pairing

On your Soundsible, open **Settings → Pair a device** and leave the QR sheet on
screen. In the app, tap **Scan the pairing code**.

Keeping the sheet open matters: it is what turns on auto-confirm, and
auto-confirm is what lets the phone finish pairing on its own. If the sheet is
closed the engine accepts the code but waits for you to confirm on the server —
and the token it mints then goes to whoever confirmed, never to the phone. The
app says so rather than spinning forever.

For a headless server, use **I already have a device token** and paste a
paired-device token with the `library:read` scope.

The credential lives in the Keychain and is only ever sent to your own server.

## In the car

Connect the phone as you normally would — Bluetooth, USB or CarPlay — and start
playback from the phone. The car shows what is playing and its buttons work.

What you get:

| | |
|---|---|
| Title, artist, album and artwork on the head unit | ✅ |
| Progress bar that tracks the song | ✅ |
| Play, pause, next, previous from the wheel or dashboard | ✅ |
| Soundsible's Now Playing screen inside CarPlay | ✅ |
| **Browsing your library from the car screen** | ❌ |

That last one is a **CarPlay app**, which needs the `carplay-audio` entitlement.
Apple grants it only to apps published on the App Store, so it is out of reach on
this distribution route. Everything above it needs no entitlement at all — it is
`MPNowPlayingInfoCenter` and `MPRemoteCommandCenter`, the same system APIs that
drive the lock screen.

## Offline

Open a playlist, album or Favourites and choose **Make available offline**. Only
what is missing is fetched, so pinning two playlists that overlap costs the
difference and not the sum.

**Settings → Offline** sets a storage limit. Anything you pinned explicitly is
never evicted; only music that was downloaded on the way past is, least recently
played first.

## Crossfade and Auto Mode

**Settings → Playback** sets a crossfade of up to 12 seconds. Halfway through the
blend the lock screen and the car switch to the incoming track — that handover
point is the thing a browser cannot control, because the Media Session API only
describes one track at a time while two are sounding.

---

## Why not the App Store

Guideline **5.2.3** forbids apps that "save, convert, or download media from
third-party sources (e.g. Apple Music, YouTube, SoundCloud, Vimeo, etc.) without
explicit authorization from those sources". Acquiring music from YouTube is what
Soundsible *is*, so the only version Apple would approve is one with the feature
removed — a library player, and not this project.

The trade is honest and worth stating plainly:

| | App Store | Sideloading |
|---|---|---|
| Apple Developer Program | 99 €/year | Not needed |
| The app can be itself | No | Yes |
| Install | One tap | SideStore, and a 7-day renewal |
| CarPlay browse screen | Possible | No |

If that ever changes, **AltStore PAL** is the upgrade path: it needs the 99 €
membership, but Apple's Notarization for EU marketplaces checks security and
integrity rather than content, installs are permanent with no renewal, and the
app would not have to be cut down. It is limited to the EU, Japan and Brazil.

---

## Building it yourself

**You do not need a Mac to build the parts that hold the logic.** `ios/`
is split so that everything except the SwiftUI and AVFoundation shell is plain
Swift:

```bash
# Core library — API client, queue, offline policy. Runs anywhere.
docker run --rm -v "$PWD/ios/SoundsibleKit":/w -w /w swift:6.3 swift test
```

The app shell needs Xcode, and the `iOS` GitHub Actions workflow is where that
happens — macOS runners are free and unmetered for public repositories. It
generates the Xcode project with [XcodeGen](https://github.com/yonaskolb/XcodeGen)
from [`ios/project.yml`](../ios/project.yml), builds an unsigned archive and
attaches the `.ipa` as an artefact.

The `.xcodeproj` is generated, never committed: nobody on this project owns a Mac
to edit one with, so a committed project file would be a file no contributor
could change.

On a Mac:

```bash
brew install xcodegen
cd ios && xcodegen generate && open Soundsible.xcodeproj
```

### Layout

| Path | What it is |
|------|-----------|
| `ios/SoundsibleKit/` | Models, API client, pairing, `PlayQueue`, `OfflineLibrary`. No Apple frameworks; tested on Linux. |
| `ios/App/Audio/` | `AVAudioSession`, the two decks, Now Playing, remote commands, the authenticated stream loader. |
| `ios/App/Model/` | `AppModel` (paired or not) and `PlayerModel` (what is sounding). |
| `ios/App/Views/` | Pairing, browse, Now Playing, settings. |
| `ios/project.yml` | The Xcode project, as YAML. |

The app targets **iOS 26** and is built against the iOS 26 SDK, so it adopts
Liquid Glass rather than opting out with `UIDesignRequiresCompatibility` — an
escape hatch Apple removes in Xcode 27 anyway. The app target runs under the
Swift 6 language mode with `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor`, Xcode
26's default for a new project; `SoundsibleKit` deliberately stays `nonisolated`
because it is the part that does work off the main thread.

### What it asks of the engine

Only what already exists — see [CAR_INTEGRATION.md](CAR_INTEGRATION.md):

- `GET /api/car/home`, `GET /api/car/items/<id>` for browsing
- `GET /api/static/stream/<track_id>`, `GET /api/static/cover/<track_id>`
- `POST /api/pairing/sessions/claim`, `GET /api/pairing/verify`
- `POST /api/devices/register`, `PUT /api/playback/state`

Everything carries `Authorization: Bearer <paired-device token>`.
