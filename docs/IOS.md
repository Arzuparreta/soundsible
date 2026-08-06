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

1. Install SideStore following its own instructions. This is the only step
   that needs a computer: SideStore is set up once from a desktop, and after
   that it re-signs your apps on the phone itself.
2. Add the Soundsible source:

   ```text
   https://github.com/Arzuparreta/soundsible/releases/latest/download/apps.json
   ```

   That URL always resolves to the newest release, so the app updates itself
   from it.

3. Install Soundsible from that source.
4. Open it and pair with your server (below).

> **Not published yet.** The source above goes live with the first release that
> carries the app. Until then the `.ipa` exists only as an artefact of the
> [iOS workflow](https://github.com/Arzuparreta/soundsible/actions/workflows/ios-build.yml);
> check [Releases](https://github.com/Arzuparreta/soundsible/releases) to see
> whether it has shipped.

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

The bottom row is not the whole story: **AltStore PAL** buys back most of what
sideloading costs, without cutting anything out of the app. It is prepared and
waiting — see below.

## The paid upgrade: AltStore PAL

Everything for this is already in the repository, dormant. It is written down
here so the day it gets paid for is an afternoon and not a research project.

### What it buys

| | Sideloading (today) | AltStore PAL |
|---|---|---|
| Cost to the developer | nothing | 99 €/year |
| Computer needed to install | once, to set up SideStore | **never** — the marketplace installs from Safari |
| Signature | expires every 7 days | permanent |
| Three-app cap | yes | no |
| Where it works | everywhere | EU, Japan, Brazil |
| Does the app have to be cut down? | no | no — Notarization reviews security, not content |

The app is free and does not monetise, so nothing beyond the membership is
owed: Apple's Core Technology Fee only starts above a million first annual
installs.

### Where you are

```bash
python3 scripts/altstore_pal_preflight.py
```

It prints the whole checklist with what is done and what is next. Steps that
happen in a browser leave nothing to detect, so record those by hand:

```bash
python3 scripts/altstore_pal_preflight.py --confirm membership
```

### The order

1. **Join the Apple Developer Program** as an individual — no D-U-N-S, verified
   in a day or two. Under the EU's Digital Services Act your name, address,
   phone and email are published on your listing, and a PO box is accepted for
   the address.
2. **Request the Alternative Terms Addendum for Apps in the EU** in the
   developer portal. Without it there is no alternative distribution at all.
3. **Register your Developer ID with AltStore PAL** through
   [their REST API](https://faq.altstore.io/developers/distribute-with-altstore-pal).
   It answers with a security token.
4. **App Store Connect → Users and Access → Integrations → Marketplace → +**,
   and paste that token. Then pick Soundsible as an app to distribute.
5. **Store the credentials** the workflow needs — the preflight names all six
   secrets and three variables, with what each one is.
6. **Run the `iOS AltStore PAL` workflow.** It builds a signed archive and
   uploads it to App Store Connect.
7. **App Store Connect → the version → App Review Information → Review Type →
   Notarization.** Save, *Add for Review*, *Submit to App Review*. This is the
   step that matters: reviewed against the Notarization Review Guidelines, the
   app is judged on security and integrity, not on where its music comes from.
8. **On acceptance Apple generates the Alternative Distribution Package** by
   itself.
9. **Collect the ADP** through AltStore PAL's REST API and host it with its
   directory structure and file hashes intact. A GitHub release asset cannot do
   that — it is a flat file. GitHub Pages on `soundsible.github.io` can.
10. **Generate the PAL source** and publish it alongside the sideloading one:

    ```bash
    python3 scripts/altstore_source.py \
      --ipa <the signed ipa> \
      --marketplace-id "$SOUNDSIBLE_MARKETPLACE_ID" \
      --download-url "$SOUNDSIBLE_ADP_BASE_URL" \
      --out apps-pal.json
    ```

Both sources keep the same bundle identifier, so PAL upgrades an existing
sideloaded install rather than putting a second copy beside it.

### What is verified, and what is not

This matters more than it looks. The PAL files sit in the repository next to
code that CI exercises on every push, and nothing about their *appearance*
distinguishes them. Anyone — a person or an agent — reading
`ios-altstore-pal.yml` could reasonably assume it works. It does not, because it
has never been given the chance.

| | Status |
|---|---|
| `ios-build.yml`, the sideloading path | **Verified.** Builds a real IPA on every push. |
| `scripts/altstore_source.py`, sideloading half | **Verified.** Runs on every release; has tests. |
| `scripts/altstore_source.py`, `--marketplace-id` half | Field names from documentation; has tests for its *shape*, but no client has ever installed from a source it produced. |
| `scripts/altstore_pal_preflight.py` | **Verified.** Has tests and runs. It is a checklist for something unverified. |
| `.github/workflows/ios-altstore-pal.yml` | **Never executed. Not once.** |
| `ios/exportOptions/app-store-connect.plist` | **Never used.** |

CI passing says nothing about the last two: nothing in CI runs them.

### Where the PAL steps came from

All read **2026-08-06**. Apple and AltStore both move these pages, so re-check
before relying on any of it.

1. [Distribute with AltStore PAL](https://faq.altstore.io/developers/distribute-with-altstore-pal)
   — the ordered steps, the Developer ID registration through their REST API,
   the App Store Connect marketplace token, and the requirement to host the ADP
   with its directory structure and file hashes intact.
2. [Make a Source](https://faq.altstore.io/developers/make-a-source) — the JSON
   schema, and that `marketplaceID` is required only for notarized apps in PAL.
3. [Submit for Notarization](https://developer.apple.com/help/app-store-connect/managing-alternative-distribution/submit-for-notarization)
   — that the build is uploaded like any other, that the difference is the
   Review Type, and that Apple generates the ADP itself on acceptance.
4. [DMA and apps in the EU](https://developer.apple.com/support/dma-and-apps-in-the-eu/)
   — that Notarization reviews security and integrity rather than content, that
   an individual developer needs no organisation, and that the Core Technology
   Fee starts above a million first annual installs.

### The guesses, in the order they will probably bite

- **`method: app-store-connect`** in the export plist. The method list found
  while researching was *app-store, ad-hoc, package, enterprise, development,
  developer-id, mac-application* — with no `app-store-connect` in it. Recent
  Xcode renamed `app-store` to `app-store-connect`; which one Xcode 26 wants was
  never confirmed. If the export complains about the method, try `app-store`.
- **`xcrun altool --upload-app`.** Documented for App Store Connect uploads, but
  altool was deprecated in favour of `notarytool` on macOS and may be gone or
  changed in Xcode 26. Fallbacks: `xcrun notarytool`, or an exportOptions
  `destination: upload` with `-authenticationKeyPath`.
- **`~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8`.** altool's documented
  lookup path, and moot if the point above changes.
- **`CODE_SIGN_IDENTITY="Apple Distribution"`.** The exact string depends on
  what the certificate is called. `security find-identity -v -p codesigning` on
  the runner will say.
- **Whether step 9 is needed at all.** AltStore's documentation mentions PAL
  processing builds automatically, which may make collecting the ADP by hand
  unnecessary.

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
