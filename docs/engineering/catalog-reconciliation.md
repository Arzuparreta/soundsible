# Album recordings and owned audio

An album listing and a downloaded file can describe the same recording while
carrying different release metadata. A YouTube download with no album used to
be excluded from the album's holdings before its recording was considered.
Playing the catalog row could then use that very video's audio with Deezer's
release snapshot, leaving the owned file's canonical record empty.

The album endpoint now overlays current account holdings using portable
recording IDs or a high-confidence cached resolution to the owned YouTube
video. Artist, full recording title and known durations within ten seconds
must corroborate the association. Conflicting IDs, duplicate owned candidates,
different versions and missing evidence abstain. Deezer's full title is retained
because its short title omits live-version labels.

GET only describes the association and whether an orphan can be repaired. The
shared album API client follows with an authenticated, library-write-scoped
POST to `/api/catalog/album/reconcile` when needed. The server rereads the
authoritative album listing, rechecks the current library under the lifecycle
lock, and commits all unambiguous repairs together. The caller cannot supply
replacement tags or a local track ID. Read-only clients may keep browsing if
the POST is forbidden; storage failures and conflicts remain errors.

Only tracks without an album and without manual metadata edits are completed.
The release record replaces the upload's position and date defaults together;
it does not mix an upload date or track 1 with the newly identified album. The
recording's ISRC is retained where supplied. Audio bytes, hashes, real duration,
acquisition dates, playlists, saved songs and favourite references remain intact.
SQLite and its derived portable export persist the repair; embedded file tags
are not rewritten. A `library_updated` event refreshes connected clients.

This is reconciliation with an album the listener opens, not a network scan of
the entire library or permission to move an existing single onto an album.

## Reproduction evidence

The reported Robe track "Contra Todos" had no album, a 420.072-second local file,
an upload-date-shaped year and track 1. Deezer lists it as track 8, disc 1 of
"Lo Que Aletea en Nuestras Cabezas", dated 2015, duration 427 seconds and ISRC
`ES71G1502918`. The existing high-confidence resolution for that catalog duration
already selected the owned video `4Rh2Hzz24xc`. Isolated regressions use that
shape without mutating a live library.

"Por Ser un Pervertido" failed earlier, during catalog resolution: the ordinary
YouTube videos search returned no rows for the full artist/title query, and the
local engine answered `404 not_found`. The same query on YouTube Music returned
the studio recording. On an empty primary match search only, Soundsible now
tries music search, then extracts metadata for at most three plausible
artist/title matches to obtain their actual durations before normal scoring.
Source errors propagate, and missing durations are never replaced by the
catalog's expected length. Successful primary searches incur no extra work.

A live investigation recovered `8lbGTPi60TA` at 344 seconds for the expected
343-second recording in approximately four seconds, resolved its stream and
read audio bytes with HTTP 206 and `audio/mp4`. Automated tests use controlled
provider responses; continued availability of a public upload is not guaranteed.
