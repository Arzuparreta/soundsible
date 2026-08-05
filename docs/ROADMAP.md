# Roadmap

Where Soundsible is going and why. This is the user-facing plan; the documents
under "internals" are working notes and may be stale or abandoned.

Nothing here has a date. Items ship when they are ready, in roughly the order
below, because each one depends on the one before it.

## What Soundsible is

Most self-hosted music tools solved *serving* music and never solved *getting*
it. Navidrome plays a library you already have. Lidarr fetches whole albums when
people listen to songs. Between "I heard this track" and "it is in my library,
tagged, on every device" there is a gap that everyone crosses by hand.

Soundsible closes that gap:

> **discover → acquire the track → land it tagged in your library → play it
> anywhere.**

Search reaches your library, Deezer, MusicBrainz and YouTube at once and returns
one ranked list. Saving something resolves it, scores the match, downloads it,
tags it and adds it. Auto Mode then plays it as a mixed set rather than a
shuffled queue.

## Where it is going

### Serve any client, not just ours

Soundsible has exactly one client today: its own player. Speaking the
**OpenSubsonic API** makes it work with the clients that already exist —
Symfonium, Feishin, DSub, Amperfy, Tempo, play:Sub and the rest — which is also
how it gets offline mobile playback, Android Auto and a watch app without
writing any of them.

That needs a real library schema first: first-class album and artist tables,
disc numbers, compilations, multiple artists per track, play counts, ratings and
last-played. And SQLite as the source of truth rather than an index rebuilt from
JSON.

- [ ] Library schema: albums, artists, disc numbers, compilations, play counts, ratings
- [ ] SQLite canonical; `library.json` becomes an export format
- [ ] `POST /api/library/scan` — point Soundsible at a folder you already have
- [ ] Read ReplayGain / R128 tags when a file carries them
- [ ] Write MusicBrainz IDs on acquisition
- [ ] OpenSubsonic API with on-the-fly transcoding
- [ ] Album, genre and year browsing in the player

### Join the open music web

- [ ] Scrobbling to ListenBrainz, Last.fm and Maloja
- [ ] ListenBrainz as a recommendation input alongside local signals
- [ ] Artist biographies and images from MusicBrainz / Wikidata
- [ ] Smart playlists over play counts, ratings, year, genre and BPM
- [ ] M3U and OPML import / export

### Make acquisition durable

The catalog depends on yt-dlp working against YouTube, and YouTube changes.

- [ ] yt-dlp updates itself in the container
- [ ] A scheduled CI canary that fails loudly when extraction breaks
- [ ] A pluggable source layer, so YouTube is one provider and not an assumption

### Sharpen what is already unique

- [ ] Auto Mode out of beta, and documented properly
- [ ] Live becomes explicitly opt-in, with self-hosting the relay documented
- [ ] Federated Live relays

## Deliberately not planned

- **Video.** Soundsible is a music server. Use Jellyfin.
- **Browsing by folder structure.** Metadata is the organising principle.
- **Being a general-purpose downloader.** Acquisition serves the library.
- **A hosted service.** You run it. That is the whole point.

## Shipped

See [CHANGELOG.md](../CHANGELOG.md).

## Internals

Working notes, not commitments. They go stale and are not maintained for
readers: [Layer Contracts](LAYER_CONTRACTS.md) ·
[Premium Quality Contract](PREMIUM_QUALITY_CONTRACT.md) ·
[Appliance Rework Plan](appliance-rework-plan.md) ·
[UI Rebuild Plan](UI_REBUILD_PLAN.md).
