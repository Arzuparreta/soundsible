# Collection identity and playable sources

## Contract

A musical item of an account has a stable `item_id`. A file has
`id` and `file_hash`; a video has its provider ID. Downloading, repairing or
removing a file changes the sources of the item, never its identity or its
playlist memberships. An occurrence in a queue additionally keeps its own
`queueId` and the audio source prepared for that occurrence.

The canonical collection lives in `users/<cuenta>/library.db`: `collection_items`
stores the item and its personal properties, `collection_keys` its
external identifiers, `collection_sources` the online sources and
`collection_files` the explicit associations with the file catalog.
`collection_user_state` keeps ratings and plays even if the source
is removed; `track_user_state` is its projection for old queries.
`playlist_tracks.track_id` keeps the historical name in SQLite, but its value
is the reference to the item, not the audio address.

Provider identifiers are not unique: two files/editions are not merged automatically
because they share a video or ISRC. Incorporation resolves
exact and unambiguous evidence, or creates an item. The internal identity of an
account is never copied from the shared catalog of the pool.

`GET /api/library/collection` materializes items, selected sources,
favourites and playlists from a single read transaction. The client can
keep using the file catalog for editing, bytes and downloads, but it does not
rebuild the collection by matching files and favourites. Collection
references are indexed by `item_id`; audio uses its source descriptor.

Adding from search/DJ sends a musical descriptor to the playlist operation.
Admission, saving and membership are confirmed in a single transaction. Acquisition builds a
separate snapshot and only publishes it in memory after confirming sources and
identities; compatibility reads do not see half-incorporated files. There is no
second save request that can fail after the reference is added.

The engine announces the capability with the `X-Soundsible-Collection` header; it does not
inject it into user settings. The snapshot returns an ETag per account and
collection/library/artwork/loudness revisions; reloads without changes
respond 304 before materializing it. Once negotiated, the web updates a
single resource. The catalog adds private references after its provider
caches; it never stores an account's `item_id` in them.

Android keeps `item_id` in program, plans, catalog resolution and
offline metadata; the URIs and occurrence IDs still pin the audio. iOS and
car receive a stable `id` and a source `track_id` separately. The offline copy
retains the persisted association even if the server selects another file.
Repeated playlist rows are selected by position, not by song.

## Migration and compatibility

The first open incorporates the files, the saved songs of the old
`favourites.json` and the playlist references. The IDs already used by the
files are kept as initial values of the internal identity; they stop
following the hash from that moment. New online incorporations receive an
opaque ID. Order, repetitions, dates, marks and cover selection are kept.

The old JSON remains as a restoration source, without being read again after the
migration completes. The old saved/favourites endpoints are facades over
SQLite. The complete and restorable copy of the collection is `library.db`
(included by `shared.instance_backup`); `library.json` is still the portable
manifest of files and references, not a backup of online items and marks.
The old technical names are only interpreted at the compatibility
boundaries and at incorporation, not on every read of a playlist.

A historical reference without sufficient evidence stays visible as an item
without an available source. Missing audio does not remove an item or its position.
The migration must fail and roll back on unreadable data; do not replace them with an
empty collection.

## Plan and acceptance

1. Replace the video → hash normalization with persisted entities and relations.
2. Migrate saves and playlists; unify their writes and reject conflicts.
3. Adapt web library, Android, search/DJ, covers and playlist editing.
4. Keep pinned sources in playback, audio-based analysis and offline copies.
5. Validate migration/restart, incorporation before/after download, repair,
   source removal, ambiguity, account isolation and concurrent writers.
6. Run Python, UI, four browser profiles and native checks;
   incorporate the current remote `main` before leaving the single PR ready.


## Decision and scope of PR #423

The original separation made sense for the sources: the hash identifies bytes
and allows sharing audio/analysis; the YouTube ID identifies a remote
resource. The failure was also using them as the musical identity of the account and
rebuilding that identity in each consumer. The persisted collection removes
that double responsibility. DJ measurements, ordering and curves are not altered:
they still depend on the analyzed audio, not on the collection identity.

The tests cover migration and reopening, duplicate references and cover,
atomic incorporation and membership with rollback, two writers, source removal and
repair, durable personal state, ambiguity, per-account caches,
ETag/304, car playlists and offline copies. The rehearsal with incident data
uses a consistent SQLite copy; it does not apply the migration to the active service.
The run evidence and its limits are recorded in the PR; it is not equivalent to
physical acceptance or deployment.
