# S2aj — Native registration through invitation

The connection field accepts the server address or its invitation link
`/player/#/invite/<token>`. Only after it is explicitly submitted is the
HTTP/HTTPS origin configured, with the same existing transport restrictions.
The token, path and credentials of the link are not stored as the server address.
Userinfo, additional query, foreign paths and tokens with an invalid form are rejected.

The APK queries the preview through the native transport and presents user and confirmed
password with the shared PasswordFields. Accept creates the Core session with the Android
device name; auth/state confirms the owner and establishes the native
profile before loading its library. It does not reload the WebView or modify the previous
account on a response from another generation. Cancelling, invalidating the owner
or unmounting the form cancels its operations.

The UI clarifies that a link can be pasted. A used/incorrect invitation shows
the same response as the web and allows going back to login. Camera capture is not added:
pasting a link uses the system keyboard/clipboard without new permissions.

Full UI 208/1606 + TypeScript pass before the textual adjustment of the hint. InviteTest
HTTP/TLS verifies real creation by an administrator, sign-up through the form,
member role/own offline profile, library without other users' songs, native cookie,
recreate keeping identity and repeated accept 400. Native2/0 HTTP/TLS (17.238s), runner exit0 + normal APK/test APK/JVM56/lint.
Initial 2/2 because of a helper waiting for unconfigured startup with a configured origin;
waits corrected, final targeted UI 5/0. See evidence/s2aj.json. Admin and multi-device remain
separate in the matrix; this does not test remote controls or OS reception of an invite.
