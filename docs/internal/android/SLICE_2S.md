# S2s: library editing preserving audio and identity

S2r confirmed the presentation/IPC on WAV. The historical editing routes
rewrite tags and can change the hash-based ID: Android needs to keep
the current source, queue, membership and offline copies when a tag changes.

New explicit contract: POST `/api/library/track-labels/<id>/metadata`, multipart
POST `/api/library/track-labels/<id>/cover` and POST
`/api/library/track-labels/<id>/cover/none`. Same write scope, rate limit,
account and coordinated writer. Metadata only accepts title/artist/album/album_artist,
limited text and explicit null only for album_artist. Canonical metadata is
saved; cover is validated and persisted in a sidecar. Do not access or rewrite audio.
The historical routes keep their behavior for other clients.

Android requires confirmation `status=success`, `storage=library` and the original ID before
refreshing and publishing native metadata. An old engine responds 404 and the editor
keeps the data to retry; there is no fallback to rehash. Copies already prepared
update tags, without changing bytes/digest/tickets. These are library changes,
not export of new tags inside the downloaded file.

Local acceptance: writer/artwork for seven formats, invalid payload,
failed persistence without publishing cover, guard against old/rehashed response and
pending account change; APK on real FLAC with tags and WAV, HTTP/HTTPS,
audio SHA-256 before/after, IPC metadata, pause/position/keys and ready copy.
Optional reproducible fixture:

```sh
SOUNDSIBLE_ANDROID_FIXTURE_AUDIO_FORMAT=flac \
  env 'ORG_GRADLE_PROJECT_android.testInstrumentationRunnerArguments.class=com.soundsible.android.MetadataTest' \
  python scripts/android.py integration
```

Prepare assets with `python scripts/android.py prepare` after UI changes.
The default value of the fixture is WAV; it only accepts synthetic WAV/FLAC and a new
directory, never personal audio. OS picker, extended APK cancellation and the other rows
are still pending. Do not call these tests full parity or alpha.


Results: **1,409 tests / 161 UI files**, **66 Python** writer/metadata/
artwork tests and **four real fixtures** pass. APK FLAC HTTP/HTTPS: **two tests pass**,
WAV HTTP/HTTPS: **two tests pass**, including audio SHA-256 before/after, ID
and format kept, text/cover/removal, occurrences/pause/position and ready copy.
Logs `/tmp/soundsible-s2s-flac.log` and `/tmp/soundsible-s2s-wav.log`; normal build
without temporary CA passes after each run. Ruff and diff correct.

Artwork payloads are validated before the writer; a storage error is not
turned into "invalid image". The metadata is confirmed before publishing the
new sidecar; an earlier failure keeps the previous artwork (an unreferenced object
may remain for maintenance). An account guard prevents a new refresh/program
when completing a response of the previous account. There is no compatibility fallback
that changes the source. [Evidence](evidence/s2s.json).

Instrumentation dirty/HEAD of previous S2r, development. The next full regression
must include MetadataTest; the last full browser runs are still S2j and will be repeated
before the cumulative PR. OS picker not accepted: the test still uses a synthetic File.
Continue entity/library actions and the rest of the matrix without closing the turn because of
a checkpoint. No PR/main/release until full parity.
