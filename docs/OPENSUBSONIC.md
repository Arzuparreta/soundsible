# OpenSubsonic

Soundsible speaks the **OpenSubsonic API** at `/rest`. Apps built for it —
Symfonium, Feishin, Amperfy, DSub, Tempo, play:Sub and the rest — browse and
play your library without knowing anything about Soundsible, which is also how
the project gets offline mobile playback, Android Auto and a watch app without
writing any of them.

The surface is served by the same engine on the same port. There is nothing to
enable: an account becomes reachable the moment it has a credential, and stops
the moment that credential is revoked.

## Connecting an app

1. Open **Settings → Other clients** in the player.
2. Press **Generate a password**. It is shown once — copy it now.
3. In your app, add a server with the address and username shown on that
   screen and the password you just copied.

If a client asks which protocol or version, it is Subsonic **1.16.1**.

## The password

The password on that screen is **not your account password**. It exists for
this protocol alone, it belongs to one account, and revoking it does not touch
anything else.

It is also the one secret in Soundsible the server can read back, and that is
not an oversight. The Subsonic handshake sends `t = md5(password + salt)`; a
server can only check that by computing the same digest, which means holding
the password itself. Every account password here is a pbkdf2 hash and could
never answer that question.

So the credential is stored encrypted with a key in the config directory
(`subsonic.key`, mode 0600), separate from the database that holds the
ciphertext. A copy of `instance.db` on its own does not hand anyone a playable
library. Losing the key file does not corrupt anything either: existing
credentials simply stop verifying, and Settings will make a new one.

Four ways to authenticate are accepted, and clients pick whichever they prefer:

| Form | Parameters |
|------|-----------|
| Plain | `u`, `p` |
| Hex-encoded | `u`, `p=enc:<hex>` |
| Salted token | `u`, `t`, `s` |
| API key | `apiKey` (the OpenSubsonic `apiKeyAuthentication` extension) |

There is **no trusted-network shortcut**. `/api/` grants some routes to callers
on the home network; `/rest` never does. Behind a Tailscale funnel the phrase
means nothing, and this surface can be exposed to the internet.

## What is implemented

**System** · `ping` · `getLicense` · `getOpenSubsonicExtensions` · `getUser` ·
`getScanStatus` · `startScan`

**Browsing** · `getMusicFolders` · `getIndexes` · `getArtists` · `getArtist` ·
`getAlbum` · `getAlbumList` · `getAlbumList2` · `getSong` · `getGenres` ·
`getSongsByGenre` · `getRandomSongs` · `getStarred` · `getStarred2` ·
`getArtistInfo2` · `getAlbumInfo2`

**Search** · `search2` · `search3`

**Media** · `stream` · `download` · `getCoverArt` · `getLyrics` ·
`getLyricsBySongId`

**Annotation** · `star` · `unstar` · `setRating` · `scrobble`

**Playlists** · `getPlaylists` · `getPlaylist` · `createPlaylist` ·
`updatePlaylist` · `deletePlaylist`

Extensions advertised: `apiKeyAuthentication`, `formPost`, `songLyrics`,
`transcodeOffset`.

Responses come back as XML (the default), JSON (`f=json`) or JSONP
(`f=jsonp&callback=`), and both the bare and `.view` spellings of every method
work. Failures travel with HTTP 200 and the protocol's own error code inside
the document, because a client that sees a 4xx reports "server unreachable"
rather than "wrong password".

`startScan` starts the same asynchronous configured-folder scan as Settings.
`getScanStatus` reports it as scanning while it is queued or reading files and
uses `count` for processed files during the run. Once idle, `count` returns to
the number of tracks in the account's library. Starting it again while a scan
is active joins the existing run instead of launching competing disk work.

## How it maps onto Soundsible

| Subsonic | Soundsible |
|---|---|
| Artists and albums | the normalized catalog in `library.db` (`artists`, `albums`, `track_artists`) |
| `artists[]` on a song | ordered performers from `track_artists`, never a split of the display string |
| Starred | the favourites the player already keeps — one mark, not two lists |
| `userRating`, `playCount`, `played` | `track_user_state` |
| `scrobble` | a play recorded against that same table |
| `replayGain` | the EBU R128 measurements the engine takes for volume levelling |
| Playlists | the ordered playlists in the account's canonical `library.db` |
| Cover art | the same artwork the player shows, embedded art extracted on demand |
| `startScan`, `getScanStatus` | the account's real configured-folder scan and live progress |

A song's `path` is built from its metadata (`Artist/Album/01 - Title.mp3`), not
read off the disk: the server's directory layout is not the client's business.

Podcast episodes live in the same canonical library as songs and are excluded from all
of it. A show is not an album.

## Transcoding

`stream` accepts `format`, `maxBitRate`, `timeOffset` and
`estimateContentLength`.

Most requests are not transcoded, and that path matters: the file is served by
the same code as `/api/static/stream`, with real byte ranges, `206` responses
and working seeks. Soundsible re-encodes only when the request genuinely calls
for it — a bitrate ceiling below the file's own, or a format the file is not —
and never for `format=raw`.

When it does, ffmpeg encodes into a pipe and the bytes are forwarded as they
appear. Such a response has no length and no byte ranges, which is how the
protocol works: a client seeks inside a transcoded stream by asking again with
`timeOffset`, and that is supported. `estimateContentLength=true` returns an
estimate for clients that want a progress bar.

Two limits worth knowing. The encoder is killed as soon as the listener leaves,
so skipping tracks on a bad connection does not leave processes running. And no
more than two encodes run at once (`SOUNDSIBLE_SUBSONIC_MAX_TRANSCODES`); past
that, and whenever ffmpeg is unavailable, the original file is served instead of
an error.

## Not implemented

Video, jukebox, chat, shares, bookmarks, internet radio, user administration,
and podcasts over this API. Soundsible has its own podcast surface under
`/api/podcasts`, and the rest are outside what a music server for one household
needs. Calls to them answer with the protocol's generic error rather than an
HTML 404, so a client reports one missing feature instead of a dead server.
