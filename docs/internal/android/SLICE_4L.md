# S4l — Visible program and public Live link

The Android panel shows title, artist and thumbnail of the dominant track and
the second track during a mix, with technique and progress. It also exposes the
program pause and keeps the controls and the chat of the native service.

It only accepts images from the Community HTTPS origin and from the path of the current room,
without user/password, query or fragment. The native interceptor reuses
LiveArtwork: no cookies/Core headers/redirects, maximum 256KiB and dimensions 512.

Share opens the system picker with a title and a link to the public hub,
built by the same helper as the web. It does not hand over media URLs or credentials.
The plugin accepts a single valid query session in /live/, without fragment or additional
query; it keeps the previous contract of song capsules and the checks
of session/generation/window focus. Opening the chooser does not confirm sending to anyone.

Validation: complete UI suite 206/1602 and TypeScript without errors. LiveUiTest and
ShareTest HTTP/TLS verify the rendered image, intercepted chooser, public
identity, rejection of extra/duplicate parameters/fragment and song regression.
Initial 4/1 because of a TLS test tapping a disabled Pause; waits and slider fixed.
Final LiveUi2/0 (24.451s), runner exit0 + normal APK/test APK/JVM56/lint.
Share2 passed in the initial run and its sources did not change. See evidence/s4l.json.
Browser4 will run before opening the final PR, together with the joint regression.
It does not claim physical acceptance or parity of the remaining matrix rows.
