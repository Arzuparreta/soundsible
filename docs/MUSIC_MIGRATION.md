# Moving from Spotify or Apple Music to Soundsible

Soundsible imports account exports rather than requiring a paid streaming
subscription or asking the Station owner to maintain third-party API keys.

You do not need to know what kind of file the services create. Open **Move your
music** in Soundsible, choose Spotify or Apple Music, and follow the instructions
shown there. Keep the resulting file exactly as the service gives it to you:
Soundsible opens it for you.

The file is uploaded only to your own Soundsible Station. Soundsible does not
send it, its contents, or migration analytics to a hosted Soundsible service or
to a third party.

## Spotify

1. In Soundsible, choose **Spotify** and open the linked Spotify privacy page.
2. Under **Download your data**, request **Account data**. Extended streaming
   history is not required, and a free Spotify account is sufficient.
3. Spotify will send an email when the download is ready. Download it without
   opening or extracting it.
4. Return to Soundsible and choose **Choose the file Spotify sent you**.

Soundsible remembers locally that you are waiting, so returning to the migration
page in the same browser takes you straight back to the final step.

## Apple Music

Apple provides the supported full-library export from its desktop library apps:

- **Mac:** Open Music and choose **File → Library → Export Library**. Apple
  documents the flow in
  [Save a copy of a playlist in Music on Mac](https://support.apple.com/guide/music/save-a-copy-of-a-playlist-mus27cd5060f/mac).
- **Windows:** Open the relevant library in iTunes and choose
  **File → Library → Export Library**. Apple documents this flow in
  [Save a copy of your playlists in iTunes on PC](https://support.apple.com/guide/itunes/save-a-copy-of-your-playlists-itns2998/windows).
  Apple does not currently document an equivalent complete-library export in
  the newer Apple Music app for Windows.
- **Phone or tablet:** Continue on a Mac or PC. The mobile Apple Music app does
  not provide the complete-library export needed by Soundsible. The guide lets
  you copy your current Station address so it is easy to reopen on that
  computer.

After saving the export, return to Soundsible and choose **Choose the Apple
Music file**. Do not open or modify it first.

## Technical compatibility

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
