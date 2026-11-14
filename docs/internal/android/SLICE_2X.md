# S2x: music acquisition and identity promotion

Library and Search offer Download in preview menus. It is not equivalent to saving a
bookmark or preparing an offline copy. The queue lives in the engine, continues without the
Activity and uses the real enqueue/status/retry/remove/clear endpoints. Downloads
shows rows shared with the web, phases/progress/failures and confirmed actions.
Clear queue removes pending/failed/interrupted, keeps downloading according to the engine's current
contract; active jobs have individual cancellation.

Intake carries video_id, display metadata and exact identity_keys. Concurrent
attempts are coalesced per account/video; do not re-enqueue an acquired file or an active
job. Confirm accepted index/ID and empty rejected before refresh. Responses
from a previous account do not refresh a new profile. Queue state is cleared with the account,
refreshed by downloader_update and visible polling while it has active jobs.

Acquiring a preview does not replace its occurrence/URI, and does not start audio. Library and
Search use shared keys (yt/lib/aliases) to keep the active indicator
when the file arrives with a hash as ID. Without an exact match do not compare by
title/artist. The next explicit selection can play the new file.

The fixture replaces only _download_audio with synthetic MP4/WebM bytes and
bounded progress/failure/delay controllable through a protected loopback+header endpoint. These
remain real: process_video, reading/tags, hash/store_track, queue checkpoint, pool and
personal transaction. Cancelling invalidates the job: even a later provider response
does not incorporate the song. Do not claim that it stops the remote transfer
or that live YouTube was accepted. Never use these fixtures on a personal library.

Python **one end to end test passes**, /tmp/soundsible-s2x-backend.log: failure/retry,
progress, acquired MP4/hash file and real Range, active cancellation without promotion,
owner does not see or delete a member's job, does not receive their files. UI **1,425/167 passes**,
/tmp/soundsible-s2x-ui-final.log: coalescing/aliases/receipt/account and real rows
with confirmation, plus the previous shared web tests.

APK **two HTTP/HTTPS cases pass**, zero failures/skipped,
/tmp/soundsible-s2x-native-local.log. Normal APK/test/unit/lint without CA passes. Asset sources prepared dirty from b364905. Check
retry/acquired hash, paused preview at 20s/keys/token preserved and the acquired file
marker; cancel Search while the provider is active without promoting the new source.
Teardown deletes acquired files only from this fixture, restores Saved and session.
Also explicitly select the acquired hash and check ready/playing with a
local source, without HTMLAudio; stop the programme before teardown. The first attempt
failed when leaving Search before the intake was resolved/accepted: the guard cancelled the
action. The test waits for real acceptance before navigating and cancelling the active
provider. Teardown also resets delay/failNext for later cases.

Pending: external entities/advanced discovery, CSV import/Settings,
sharing/multi-device, DJ/Live/Auto, signing/update/release. Extended principal
regression and four browser profiles before the final PR; alpha only with full parity.
