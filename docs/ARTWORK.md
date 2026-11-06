# Artwork storage and delivery

Soundsible keeps the best available artwork outside the audio file. Audio
repair can still shrink embedded pictures without reducing UI quality.
Original bytes are stored once by SHA-256 under `data_dir/artwork/objects`;
`data_dir/artwork/index.sqlite3` holds references, dimensions, provenance,
revisions, account overrides, source observations and recovery progress. Back up and restore the **whole artwork
directory**, alongside the library and `config_dir/.artwork-selection-key`. The documented Docker data-volume backup
already includes it. Stop the service during a filesystem backup.

Variants live under `cache_dir/artwork` and can be deleted while the service is
stopped. Originals cannot be reconstructed from these smaller images. Retired
originals are retained, including after a track changes identity; there is no
automatic destructive garbage collection in this change.

## Existing libraries

An automatic background worker starts after API startup. It preserves local
embedded artwork and matching larger legacy cache images first. For tracks
marked as YouTube artwork, it checks that video's higher-resolution image,
accepting only a larger image with compatible proportions and a conservative
perceptual match. It does not search by title or substitute official album art.
Manual, removed and unknown-source artwork never triggers external recovery.
A manual edit wins over an in-flight recovery result.

Recovery is resumable: one worker, at most one external request per second,
bounded retry windows with exponential backoff, and persisted provider `Retry-After` support.
Failures and unavailable improvements are recorded with reevaluation deadlines rather than retried on every boot. New material source evidence can reopen evaluation. If a better source is unavailable, the existing image remains.
A perceptual match is a conservative heuristic, not proof of image identity.
Diagnostics in the index distinguish preservation, improvement and failures;
debug logs report state totals, stored bytes and elapsed time. The worker does
not download remote audio and image HTTP requests never query providers.

## HTTP contract

`GET /api/static/cover/<track_id>` retains the original-image behavior and
returns the actual MIME type. `size=thumb` remains compatible. New `size` values
are `160`, `320`, `640`, `960`, and `1280`; `fit` is `original` (default) or
`square`. Square variants crop before resizing. No variant enlarges the source.
JPEG variants use quality 90 and normalized orientation.

Library responses add optional `artwork_revision`, `artwork_width` and
`artwork_height` and account-specific `artwork_scope`. The UI uses these to build `srcset` with the actual available
square resolution. `rev` identifies the artwork revision; current revision
responses are privately cacheable for a year with `ETag`. A stale revision
redirects to the current one without immutable caching. Unversioned requests and placeholders revalidate privately, including after an account change. A temporary processing failure returns 503 with `no-store` and `Retry-After`, rather than caching an absent cover. Original content is deduplicated; variants
are generated once per content hash, size, crop and transform revision with
one active transform in a lazy child with bounded admission and a deadline including queue wait. The same child validates new master images outside the cooperative HTTP hub. CLI tools without gevent retain local processing.

The shared image component measures its slot, lets the browser choose density,
and lazy-loads offscreen artwork. NORMAL and DJ share the same rendering path.
It is reserved for large surfaces (player stage, album/artist/playlist grids,
search cards). List rows stay a CSS background on the 320 px `thumb` variant:
their cover is at most 60 CSS px, which that variant already covers at 3x, and
queue lanes are not virtualized — one measured `<img>` per row there was enough
to starve WebKit of frames on a mobile runner.
External catalog pictures keep provider-supplied URLs. A catalog acquisition
can preserve the explicitly chosen album image after server verification and
an account-bound authenticated receipt. Audio publication does not wait for it;
the recovery worker processes that durable choice. User-edited and removed
covers belong to that account, shadowing the shared source. Ambiguous legacy
global manual refs are preserved. No arbitrary URL proxy is introduced.

YouTube search uses declared thumbnail candidates already present in extractor
responses. Resolution retains public source observations; the existing preview
status response can carry a better same-video primary thumbnail. Failed optional
upgrades retain their previous image. Guessed dimensionless extractor URLs and
alternative video frames do not outrank known primary references.

See [architecture and validation](audits/2026-11-07-artwork-requests.md) for
resource ownership, cancellation, recovery and remaining platform limits.

## Historical local validation sample

A 100-image sample from the existing local cache averaged 289.9 KiB per
original. Square JPEG variants averaged 8.2 KiB at 160 px, 25.9 KiB at 320 px,
56.0 KiB at 640 px and 65.3 KiB at 960/1280 px (those last sizes converge because
sources are not enlarged). Mean local generation time was 7.89 ms per variant;
a warm variant lookup was 0.019 ms. These are filesystem measurements on the
development machine, not HTTP latency or a guarantee for another library.
