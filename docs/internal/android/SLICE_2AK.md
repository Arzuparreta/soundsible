# S2ak — Native people and administrative permissions

Android offers People only to administrators within Settings. It reuses the
web UsersPanel with an explicit account and ownership provider, without enabling the
web playback store. It lists users, creates accounts and invitation links,
sets passwords, enables/disables and deletes with confirmation like the web.

The operations check account/ownership and panel lifetime before starting,
after dialogs and before publishing responses or copying an invitation. Unmounting
the panel invalidates responses; the bridge generation still protects the
transport. If the connection stops being available the Android controls become
disabled. The server keeps the real administrative authorization.

Full UI 209/1610 and TypeScript pass. UsersPanel tests check the native provider,
a member without requests, a late confirmation without DELETE and a late invite without copying.
UsersTest HTTP/TLS checks the real panel on a persisted admin account, creation
with PasswordFields, invitation, disabled confirmed by Core and navigation/API 403
for a member. Native2/0 HTTP/TLS (25.67s), runner exit0 + normal APK/test APK/JVM56/lint.
Evidence in evidence/s2ak.json. Reset password/delete keep shared actions
and unit guards; not all of them are triggered in this Native acceptance.

It is not equivalent to media controls between devices: that contract requires a
socket and a native owner in PlaybackService, in addition to the listing/actions in Settings.
Full Browser4 before the PR also covers the change to the shared web panel.
