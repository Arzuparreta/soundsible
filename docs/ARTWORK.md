# Artwork storage and delivery

Soundsible keeps the best available artwork outside the audio file. Audio
repair can still shrink embedded pictures without reducing UI quality.
Original bytes are stored once by SHA-256 under `data_dir/artwork/objects`;
`data_dir/artwork/index.sqlite3` holds references, dimensions, provenance,
revisions and recovery progress. Back up and restore the **whole artwork
directory**, alongside the library. The documented Docker data-volume backup
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
three attempts with exponential backoff, and provider `Retry-After` support.
Failures and unavailable improvements are recorded rather than retried on
every boot. If a better source is unavailable, the existing image remains.
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
`artwork_height`. The UI uses these to build `srcset` with the actual available
square resolution. `rev` identifies the artwork revision; current revision
responses are privately cacheable for a year with `ETag`. A stale revision
redirects to the current one without immutable caching. Unversioned requests
retain the existing seven-day private cache policy. Unknown tracks and broken
images retain placeholder behavior. Original content is deduplicated; variants
are generated once per content hash, size, crop and transform revision with
at most two concurrent transforms.

The shared image component measures its slot, lets the browser choose density,
and lazy-loads offscreen artwork. NORMAL and DJ share the same rendering path.
External catalog pictures keep their provider-supplied URLs; no arbitrary URL
proxy or speculative URL rewriting is introduced.

## Local validation sample

A 100-image sample from the existing local cache averaged 289.9 KiB per
original. Square JPEG variants averaged 8.2 KiB at 160 px, 25.9 KiB at 320 px,
56.0 KiB at 640 px and 65.3 KiB at 960/1280 px (those last sizes converge because
sources are not enlarged). Mean local generation time was 7.89 ms per variant;
a warm variant lookup was 0.019 ms. These are filesystem measurements on the
development machine, not HTTP latency or a guarantee for another library.
