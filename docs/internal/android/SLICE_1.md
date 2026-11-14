# First functional slice: connection, account and real library

## Result

From the local APK, choose a Soundsible instance, log in and browse the
real library with covers and update events. Do not implement yet
playback, offline, DJ, Live, Android Auto or publication. The first
connected screen must reuse the existing Solid interface, not a new Android catalogue.

## Mandatory technical preparation

1. Review `apiOrigin`, `http.request`, `session`, `createSocket`, cover and
   stream URLs, `/api/auth/*`, cookies, CORS and `on_socket_connect`. Characterize with a
   fixture the single-user passwordless and multi-user member/admin accounts.
2. Test the existing session over the Android transport: login → `/api/auth/state`
   → authenticated resource → socket with the same account → logout. The cookie is
   HttpOnly/SameSite=Lax; **changing `same-origin` to `include` is not enough**.
3. Solve the native transport/cookie jar and Socket.IO in a demonstrable way,
   keeping roles and scopes. Document the technical decision and tests in
   ARCHITECTURE before connecting all the stores. If it needs API evolution,
   keep web/iOS compatibility and add isolation/regression tests.
4. Give explicit support to private/LAN HTTP and remote HTTPS without opening arbitrary
   traffic or remote navigation with access to the bridge. The emulator reaches the
   host with `10.0.2.2`; its localhost is not the engine. Document Tailscale/LAN/DNS.

Account login is the initial path to parity. Limited pairing can be
offered later, but it does not replace permissions for all actions with an owner
token. The transport test is a functional gate of the slice, not a justification
for leaving the APK with a security bypass.

## Implementation

- Server configuration with URL validation and actionable errors. Store the
  address without credentials; session and any secret in protected native
  storage. Never persist the user's password.
- A single adapter for origin, session and resources. Preserve abort/timeout/status,
  FormData, 304/ETags and isolation. Do not scatter Android logic across screens.
- Mount the authenticated client only after resolving identity. When server/account
  change, unmount the runtime, cancel jobs and reset namespaces/caches
  before the next account; ignore late responses.
- Library, navigation to collections and real covers; authenticated change
  events. Audio actions still pending must not appear to work
  or create web audio by accident. The limitation is for development, not an alpha.
- Logout, expired session and network down with explicit recovery; show again
  login/configuration according to the reason, without silently deleting valid data.

## Acceptance and delivery

Use an isolated test engine, fixtures and two accounts. Test local HTTP and
remote HTTPS connection, passwordless, member and administrator, wrong password,
unreachable server, 401/403, expiration/revocation, restart, account switch and
server switch with jobs in flight. Verify that REST, images and events do not leak
data between accounts or credentials to third parties. Test relative/external cover,
empty list and reconnection with a library change. Do not expose another
user's library during boot and do not accept only the happy path.

Unit/contract tests, backend if it changes, four full browser profiles
and a packaged APK in the emulator. Keep commands, build-info, logs without secrets
and the result. Update matrix/HANDOFF and close with a focused commit, without push,
PR or publication unless instructed later. If a PR is opened: fetch/ancestry of
the current base and exactly one impact label according to AGENTS.

## Status after implementation

Functional core implemented and tested with APK/API 36 and disposable engines.
See [evidence](evidence/s1.json) and [handoff](HANDOFF.md). Still pending is
positive acceptance against a remote HTTPS instance with a valid certificate and
real DNS/Tailscale. The read-only surface does not claim action parity.
The user authorized push after S0; PR/merge/publication have still not been requested.
Next cut: [native audio S2](SLICE_2.md).
