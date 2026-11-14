# S2ag: Subsonic access from Android Settings

## Contract

Reuse the Subsonic presentation of the web client, with native account
transport. Show the real engine URL, never the localhost origin of the bundle.
The state must come from GET /api/auth/subsonic; do not offer actionable defaults
if it fails. Generate/replace/revoke requires a receipt and a confirmed read within
the same server scope, identity, account ID and username.

The password is delivered only once and stays in the panel's memory. Leaving,
losing the connection, switching account or server removes it. It does not go to preferences,
offline cache, program, logs or diagnostics. A replacement or revocation asks for
confirmation; cancelling it does not mutate the server. A pending confirmation loses
validity when the scope changes.

Copying is an explicit action to the Android clipboard. The bridge validates generation
and session before writing, marks the password as sensitive and does not read the
clipboard to hand it to JavaScript. Do not use a browser credentials fallback.
[Android reference](https://developer.android.com/develop/ui/views/touch-and-input/copy-paste):
ClipData.newPlainText and ClipDescription.EXTRA_IS_SENSITIVE hide the preview of the
sensitive content in the OS notice.

## Pending acceptance

- HTTP and HTTPS against the real isolated engine: generate, authenticate /rest with form
  POST, replace and prove rejection of the old credential, revoke and prove
  later rejection; check that the owner account stays independent.
- Cancelling confirmation sends no mutation; recreating the Activity keeps the configured
  state but never the password; switching account does not leak state/secret.
- Real copy of address/password, sensitive flag and rejection of an old generation.
  Do not print secrets/cookies in asserts, DOM timeouts or logs. Redact
  [data-subsonic-secret] in the instrumented diagnostics.
- Program, keys, pause and session are kept. No HTML audio and no additional owner.
- Complete UI suite and four browser profiles after extraction of the web view.
- Normal APK/test APK/JVM/lint without temporary CA after instrumentation.

## Implementation status

Shared pure view extracted, cancellable controller and Android route connected
in sources after the clean prepare 46a6c3d. The JS clipboard adapter requires
the native SoundsibleClipboard plugin, already added after finishing principal73. Do not attribute these
changes to the current main artifact. Do not mark parity or publish alpha.

First targeted Native2 passes HTTP/TLS in /tmp/soundsible-s2ag-native.log,
normal APK/test APK/JVM20/lint without CA pass. Real credentials authenticate via
form POST /rest/ping; replacement invalidates the first one and revoke invalidates the second one,
owner keeps access, the Activity does not reveal the secret, clipboard flags and rejection
of an old generation verified. UI1547/195 passes /tmp/soundsible-s2ag-full-ui.log.
Subsonic + Account4 extension in progress: the first Subsonic run fails while waiting for the dialog
because the helper chose the header Sign out instead of the Account row. Specific
scope of the locator pending when the runner finishes. Do not accept the account
switch yet or attribute green to the failed targeted4. Browser4 of this
extraction still pending. Freeze Native inputs until the runner finishes.

Extended targeted acceptance 4/0 in /tmp/soundsible-s2ag-account-fixed-native.log:
Subsonic2 HTTP/TLS includes confirmed logout from the Account row and a new owner
login; the temporary password disappears and username/state correspond to owner,
the credentials of each account stay independent. Account2 regression passes.
Normal APK/test APK/JVM20/lint without CA pass, own XML integration-targeted.
Previous runner account4 failed 2 only because of the header locator; kept
as diagnosis. Clean principal73+restart2 not overwritten. Browser4 in progress.

Final Browser4 passes: Chromium278/66 + WebKit269/75, zero failures, 1 worker
sequential and WebKit readonly. Logs /tmp/soundsible-s2ag-{chromium,webkit}.log.
Web input frozen during both runs; later Native DSP excluded.
