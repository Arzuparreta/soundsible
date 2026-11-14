# S2o: playlist management with write conditions

Three-dot menus of playlists and collections offer rename, duplicate,
delete, sort and choose an acquired cover. Rows offer moving and removing
an occurrence: filtering a playlist with repeated IDs keeps the original index.
The file is not deleted when removing membership or when deleting the playlist.

The new `/api/library/playlist-edits` routes require the captured order or
membership. A concurrent change returns 409 without overwriting it; an old
engine rejects the route without applying an unconditional write. The UI confirms
the real response, refreshes and keeps errors visible. Prompts, confirmations and
covers are closed on account change. Duplicate confirms creation first and then
content; if the second step fails, a recoverable empty playlist can remain.

The order is persisted in `settings.playlist_order`, independent of the order of
JSON keys. New names are added deterministically; renaming keeps the
position. Validating the whole payload before modifying avoids partial renames
when tracks or cover are invalid. The historical endpoints keep their contract.

The APK walkthrough must observe the updated UI state before capturing
the next operation, in addition to checking the server: a write response
does not guarantee that its refresh has already arrived. See HANDOFF for concrete results.
It does not close library parity or enable an alpha: other actions, DJ, Live,
Auto and distribution keep their gates.
