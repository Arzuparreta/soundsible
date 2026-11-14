# S2y: import from the user's export

S2x closed/pushed in dc3349d. Continue without ending the turn per slice. Real baseline:
`ui_web/src/routes/Migrate.tsx` (~800 lines) and `lib/migrationApi.ts`, job APIs
upload/list/get/start/control/decision. The legacy preview/import-playlist APIs do not
cover selection, progress, pause/resume/cancel/retry or candidate review.

Reuse the full view with a minimal web adapter (useNavigate), native props
to open playlists and a compact header. Keep the Spotify/Apple guide, formats,
library/playlist selection, progress, decisions and job recovery.
Inject the real engine address into Copy station address; Capacitor's window.location
is local and is not a useful address to continue on the computer.

All migrationApi requests accept an optional AbortSignal. The view has
lifetime/account, a guard after each await and cancellation of restore/poll/upload when
leaving/changing account. Poll does not accumulate requests; an earlier response does not adopt a
job or show a toast in the new account. Keep progress on a temporary failure.

Real parser limit: shared/migration/parsers.py MAX_UPLOAD_BYTES100MiB,
MAX_MEMBER_BYTES25MiB, MAX_ARCHIVE_FILES100. The bridge's current multipart converts
File to arrayBuffer/base64 without its own limit: do not use it for large exports.
Implement a dedicated import plugin: real ACTION_OPEN_DOCUMENT picker,
content URI grant per file, a RequestBody that reads the stream in chunks to the
authenticated POST /api/migration/jobs with the captured generation. Do not expose the URI to JS,
no broad permissions, no base64 buffers of the whole file. JS receives only a cancellation or an opaque token, name, MIME and size. The token is
consumed once in the usual multipart transport to keep ApiError and
the existing unauthorized handler. URI and bytes never cross the bridge. The grant
is bound to generation, profile and a private session fingerprint; it expires after
10 minutes and each upload has a limit of 120 seconds.
Query the provider metadata off the UI thread, with CancellationSignal,
timeout120s and bounded workers/queue. Accept MIME application/* and text/*, because
the MIME name of CSV/plist varies between providers; the parser validates format and
content. Keep the 100MiB limit and the timeout120s of the contract, close the stream/cancel the request
on account/cancel/destroy/timeout; a URI from an earlier account is not uploaded to another one.

The view offers an injected native chooser; the web keeps the current File input/drop and multipart
API. Back from the picker keeps the guide/job and does not upload. Seed a synthetic CSV
in MediaStore.Downloads, choose it by unique filename in DocumentsUI with a
real tap (without simulating the callback or an arbitrary URI). Test HTTP/HTTPS against the real parser/
matcher/store/service, acquired playlist, controls/review and private account.
Fixtures use synthetic bytes/provider, not a personal export or library.

Verify format/size/unknown-size and stream close/cancel with meaningful native
tests, full web/native UI, API contract and OS picker end to end. Alpha
then requires the rest of parity, DJ/Live/Auto and signature/update/release gates.
