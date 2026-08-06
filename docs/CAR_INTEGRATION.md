# Car Integration

Soundsible has three car-facing layers:

1. **Phone native player surfaces**: Bluetooth, USB, lock screen, and car media screens that mirror the phone's Now Playing state.
2. **Native companion apps**: iOS first, Android later.
3. **Official projection surfaces**: CarPlay and Android Auto.

The web player now owns the fast path through the browser Media Session API. That improves metadata and controls for phone-native media surfaces, but it does not make the PWA a CarPlay or Android Auto app.

## Current Web / Bluetooth Layer

The web player publishes absolute Media Session artwork URLs, playback state, position state, and handlers for:

- play
- pause
- next
- previous
- seek backward / forward
- seek to position

This is the best available path for Safari/Chrome lock screens, Bluetooth controls, USB media surfaces, and car-native "Now Playing" views that mirror the phone. It is still browser-mediated, so individual cars and browser versions may differ.

## API Contract

Native car clients should start with:

```text
GET /api/car/home
GET /api/car/items/<item_id>
```

These endpoints require `library:read` or an owner token. In advanced/headless compatibility mode, trusted LAN/Tailscale clients are also allowed.

Every returned item uses this stable shape:

```json
{
  "id": "track-or-collection-id",
  "kind": "track",
  "track_id": "optional-library-track-id",
  "title": "Title",
  "subtitle": "Artist - Album",
  "artist": "Artist",
  "album": "Album",
  "duration_sec": 180,
  "artwork_url": "/api/static/cover/<track_id>",
  "stream_url": "/api/static/stream/<track_id>",
  "is_browsable": false,
  "is_playable": true
}
```

Root collections:

- `recently-played`
- `favourites`
- `playlists`
- `podcasts`
- `radio`
- `all-tracks`

Playlist IDs are encoded as `playlist:<url-encoded-name>`.

## iOS Companion — built

The native iOS client lives in [`ios/`](../ios) and is documented in
[IOS.md](IOS.md). It does what this document specified:

- Pairs through the existing flow and keeps the paired-device token in the Keychain.
- Browses `/api/car/home` and `/api/car/items/<item_id>`.
- Plays `stream_url` through `AVPlayer`, with background audio enabled.
- Publishes `MPNowPlayingInfoCenter` and handles `MPRemoteCommandCenter`.
- Registers as `device_type: "ios"` and publishes state to `/api/playback/state`.

Two things the original sketch did not say, and both matter:

**`AVPlayer` cannot carry an `Authorization` header** through any public API. The
app routes authenticated streams through an `AVAssetResourceLoaderDelegate` on a
custom scheme, which forwards byte ranges to `URLSession` where headers are
ordinary. The private `AVURLAssetHTTPHeaderFieldsKey` is not used.

**Now Playing is not a formality.** A head unit's progress bar only moves if
`MPNowPlayingInfoPropertyElapsedPlaybackTime` and
`MPNowPlayingInfoPropertyPlaybackRate` are both published, and head units draw
their buttons from which `MPRemoteCommand`s are enabled — so commands the queue
cannot honour are disabled rather than left on.

## CarPlay Target

**Blocked, and not by us.** The `com.apple.developer.carplay-audio` entitlement
is granted only to apps published on the App Store, and Soundsible is not going
there: guideline 5.2.3 forbids downloading media from YouTube, which is what
Soundsible does. The app is distributed by sideloading instead (see
[IOS.md](IOS.md)).

This costs less than it sounds. A CarPlay app would add **browsing your library
on the car screen**. Everything else a car shows — title, artist, artwork, a
progress bar that tracks, transport buttons on the wheel, and Soundsible's Now
Playing screen inside CarPlay itself — comes from `MPNowPlayingInfoCenter` and
`MPRemoteCommandCenter`, needs no entitlement, and already works.

If Soundsible ever ships through **AltStore PAL** (EU marketplaces, 99 €/year,
Notarization checks security rather than content) that is still not the App
Store, so the entitlement stays out of reach. The tree below is what a CarPlay
target would render if that ever changes:

- Home
- Favourites
- Playlists
- Recently Played
- Podcasts
- Radio Seeds

Avoid rich/free-form UI on the car display. Search and complex discovery should remain on the phone or desktop unless the official CarPlay templates allow the interaction safely.

## Android Target

The later Android app should expose the same `/api/car/*` tree through Media3 `MediaLibraryService` and `MediaSession`. Android Auto and Android Automotive OS can then render the browse/playback UI from the native Android media session.
