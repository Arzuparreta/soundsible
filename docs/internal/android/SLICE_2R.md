# S2r: first metadata and cover art vertical

First path implemented and validated with WAV audio. It does not yet close
editing parity: formats with tags can change ID when the
file is rewritten. That case requires an editing contract that preserves source/identity
and its own acceptance before this row is considered complete.

Reuse the MetadataEditor form/styles/texts through a presentation
without imports of web stores/audio. Web keeps its adapter; Android provides native REST
handlers and a captured scope. Edit title/artist/album/album_artist via POST
`/api/library/tracks/<id>/metadata`; confirm status and snapshot after refresh.
The engine supports a metadata-only fallback: show the confirmed library, without claiming
that the file was rewritten if it responded with the fallback.

Cover art: upload a FormData file via POST `/api/library/tracks/<id>/cover` and POST
`/api/library/tracks/<id>/cover/none` to remove it. Real responses, artwork refresh/revision, visible error
without closing and cancellation/closing of the editor when switching account. Do not accept provider
URLs entered by the client or an audio URL. Separate the APK multipart
test from the acceptance of the OS picker: a synthetic File does not test Photo Picker.

The program must receive confirmed metadata changes without rebuilding sources,
losing position/pause or changing keys/tokens. Use the existing MediaItem with new
metadata, preserving localConfiguration/extras and limits; do not accept a new URI from
the UI. Media3 allows attempting continuation when replacing a compatible item that only
has different metadata; verify the behavior with the installed version, do not
turn that documented possibility into a guarantee:
[Player.replaceMediaItem](https://developer.android.com/reference/androidx/media3/common/Player#replaceMediaItem(int,androidx.media3.common.MediaItem)).

Acceptance: HTTP/HTTPS, confirmed text/cover and revised private cover art,
current metadata and repetitions in the queue, position/pause/occurrences kept,
recoverable failure, scope/account and closed editor. Do not invalidate valid offline copies
because of a text change; review their local metadata and cover policies
separately. Save evidence per layer and pending items. The other library actions,
DJ/Live/Auto and signing/update keep their gates.


## Local evidence

Typecheck/Vitest: **1,405 tests / 160 files**, including three presentation tests
(error/retry, confirmation and close by account). Python: **49 tests** of metadata
and artwork. Ruff/diff pass. Verified HTTP/HTTPS APK: **two tests pass**,
real editing, multipart/green bitmap served by the engine, cover removal, two
occurrences and ready copy labels keeping bytes/pause/position/keys/token.
The file picker is simulated with File: it does not test the OS picker.

The engine reported WAV without tags as success without saving changes or linking artwork;
it now keeps canonical metadata and a sidecar without altering the audio. A null album_artist
in the fallback clears the value explicitly. Media3 keeps localConfiguration when
replacing only metadata and the artwork revision; extras allow waiting for new IPC.
Existing copies update labels in SQLite without downloading them again.

The first failures belonged to the fixture: ArtworkStore.path returns str and the
title selector found the hidden file input. Fixed while keeping the
assertions. The last complete APK suite is S2q (31 + two offline phases); the last
complete browser runs are S2j. Repeat on the final HEAD before the PR. No CI, live
provider, OS picker or physical acceptance. Instrumentation dirty/previous HEAD,
development artifact. [Evidence](evidence/s2r.json).

Continuation: editing without rehash to preserve source and identity in all
formats, picker/cancellation validation and the rest of the library; then the
complete DJ/Live/Auto matrix and signing/update. Do not enable a partial alpha.
