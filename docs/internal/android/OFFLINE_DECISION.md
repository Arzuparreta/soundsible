# Offline: approved decision

Date: 2026-10-03. The user chooses to **include B: explicit copies of music already
acquired on the server**, named "Available offline". Actions inside
the three-dot menus of songs/collections; no preparation button in
the shells. Technical correctness and storage are left to the implementation's judgment.
The user confirms keeping full parity before alpha; push progress and
continue until parity, then a PR to main and a release. Do not publish a partial alpha.

## Product contract

Acquiring music for the server and keeping a copy on the phone are separate
operations. Saved/bookmark and preview are not equivalent to an acquired file. Only
local music songs are eligible in this first offline version; previews are not
acquired implicitly. An album/playlist prepares its current local members; it does not
synchronize or acquire new additions automatically.

One library, with the "Only on this device" filter in its menu. Preparation,
removal and cancellation live in the song/collection menus. Management of
progress, errors and space is accessible from the same library menu. Prepared
means a complete file, checked length, recognized duration and checksum;
a partial or failed copy never counts as available. Offline artwork uses a
placeholder; metadata is kept for songs/albums/artists/playlists.

Explicit copies without automatic eviction. Initial limit 2 GiB, configurable to
512 MiB/2 GiB/8 GiB from management; maximum 1,000 songs per profile in this cut.
The limit can be reduced without deleting copies: new preparations must fit.
The device's real space keeps a reserve. Cancel/remove frees only copies
on the phone, never files on the server.

## Before, during and after the flight

Before: open the song/collection menu, choose "Available offline" and check
management until all the desired members are ready. Mixes with previews
prepare only acquired members. The ready/total count and failures are shown.
During: the app starts from local assets and the metadata of the verified profile; the library
filters ready copies when the engine cannot be reached. NORMAL/queue/seek/shuffle/repeat use
the same media service with private files. It does not create a standalone server.
After: revalidate the account, refresh the library and return to online routes. No pending
favorite/playlist/progress mutations are sent: this cut does not
create them. Files deleted from the server remain removable in the local filter.

## Account and lifecycle

Profile bound to the origin and to the account verified by native auth. Logout, change of
server/account or an observed 401 revocation delete copies and cancel preparation.
Without network, a remote revocation cannot be known: prepared copies remain
available until reconnection or local logout. Activity recreation does not interrupt
preparation. Explicit download through a dataSync foreground service; an OS
limit/interruption/process death leaves an incomplete preparation that can be recovered with Retry,
without declaring availability or unexpectedly resuming network work at startup.

## Acceptance and publishing

Validate the real path, UI preparation, persistence, startup with an unreachable engine,
playback/seek/background, batch/duplicates/cancellation, partial failure, space,
integrity, isolation and logout. Record evidence in HANDOFF when closing.
Offline approval does not replace phone/DJ/Live/Android Auto acceptance.
Parity was merged through PR #300; signature, update and publishing are
closed with RELEASE_GATES. Physical car/sound acceptance belongs to
beta. iOS is a code reference, not device acceptance.
