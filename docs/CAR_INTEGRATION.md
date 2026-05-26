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

## iOS Companion Target

The iOS app should be a native audio client:

- Pair through the existing Soundsible pairing flow and store the paired-device token in Keychain.
- Use `/api/car/home` and `/api/car/items/<item_id>` for browse.
- Use `AVPlayer` for `stream_url` playback.
- Enable background audio.
- Publish `MPNowPlayingInfoCenter` metadata from the selected item.
- Register `MPRemoteCommandCenter` handlers for play, pause, next, previous, and seek.
- Keep the server playback state updated through existing `/api/playback/state` once a native device ID exists.

The native client should register itself as `device_type: "ios"` through `POST /api/devices/register`. Remote commands accepted by Soundsible are `play`, `pause`, `next`, `previous`, and `seek`.

## CarPlay Target

CarPlay is a native entitlement path, not a PWA capability. The implementation should only start after the iOS app has stable background playback and Now Playing behavior.

Minimum CarPlay tree:

- Home
- Favourites
- Playlists
- Recently Played
- Podcasts
- Radio Seeds

Avoid rich/free-form UI on the car display. Search and complex discovery should remain on the phone or desktop unless the official CarPlay templates allow the interaction safely.

## Android Target

The later Android app should expose the same `/api/car/*` tree through Media3 `MediaLibraryService` and `MediaSession`. Android Auto and Android Automotive OS can then render the browse/playback UI from the native Android media session.
