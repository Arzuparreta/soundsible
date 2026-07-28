# Moving a Spotify or Apple Music library to Soundsible

Soundsible imports account exports rather than requiring a paid streaming
subscription or asking the Station owner to maintain third-party API keys.

## Supported exports

- Spotify account-data ZIP files and `Playlist*.json` files. Spotify documents
  that its account-data package contains playlist names and the songs, artists,
  albums, local tracks, and saved songs in those playlists:
  <https://support.spotify.com/article/understanding-your-data/>.
- Apple Music library or playlist XML, plus the text/CSV variants exported by
  Music. In Music on macOS, use **File → Library → Export Library** for the
  complete XML or **Export Playlist** for XML/text:
  <https://support.apple.com/guide/music/save-a-copy-of-a-playlist-mus27cd5060f/mac>.

The importer intentionally ignores streaming history, podcasts, movies, and
music videos. An export contains metadata, not the streaming services' audio.

## Import behavior

1. Uploading an export creates a user-scoped, durable analysis job.
2. Soundsible matches the source against the user's library using bounded
   indexes, then against the Station's shared track pool.
3. The user selects the saved library and individual playlists. Duplicate
   source tracks are processed once.
4. Existing tracks are reused. Missing tracks are resolved through the existing
   catalog/YouTube pipeline. Only high-confidence results download
   automatically; doubtful results stop for review.
5. Playlist names and source order are preserved. Name collisions receive a
   provider suffix instead of overwriting an existing playlist.
6. Spotify Liked Songs and Apple `Loved` entries become Soundsible favourites.
   Importing an ordinary Apple library does not mark every song as a favourite.

Jobs survive page reloads and process restarts. A running download finishes
before a pause or cancellation takes effect; the job then stops before the next
track. Failed downloads can be retried, and uploading the same export reopens
the existing job instead of duplicating its work.

## Why account exports are the default

As of July 2026, Spotify Development Mode requires the app owner to have
Premium and limits new apps to five users:
<https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide>.
Apple Music user-library requests require MusicKit authorization and service
token setup:
<https://developer.apple.com/documentation/applemusicapi/user-authentication-for-musickit>.

A direct account connector can be added later for deployments that meet those
requirements. It should remain an optional shortcut over the same migration-job
engine, not a prerequisite for moving a library.
