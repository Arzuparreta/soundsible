# Isolate the login budget between APK tests

The S2t main suite ended with **35 tests, one LibraryActions HTTP failure**, without reaching
restart or the normal rebuild. Connection and EntityBookmarks accumulated enough
logins on the same IP/window for the LibraryActions owner login to exhaust
the engine's real limit (10/minute). It was not a loss of permission or of a playlist.

Filtered reproduction Connection + EntityBookmarks + LibraryActions: **eight tests,
one failure**, same owner assertion and fixture record **auth_login status=429**.
Logs `/tmp/soundsible-s2t-auth-repro.log` and
`/tmp/soundsible-auth-repro-fixture.log`. The record only keeps status/time,
never password, cookie or body. The audit is limited to 100 events.

FixtureIsolationListener clears only auth_login for that IP at the start of each
independent JUnit case. It uses a client without credentials, verified HTTPS and the
same private cleartext exception; it does not change the app's connection/preferences.
The integration helper installs that listener; the two persistent offline phases
follow their direct protocol and do not reset storage between them.

POST /__fixture/reset-auth-limit only exists in scripts/android_fixture.py,
requires loopback and X-Android-Fixture=isolated, before the account lookup, so that
the passwordless fixture is also accepted. It does not touch cookies, accounts or other limits.
The limit within each case remains active; production does not change.

Real Python confirms ten wrong attempts 401, the next one 429, reset without header
403/no effect, protected audit and explicit reset allows the next login.
**One test passes** in `/tmp/soundsible-auth-fixture-test.log`. APK rerun of the
same group with isolation: **eight tests, zero failures/skipped**, normal APK/test/
lint without temporary CA passes, `/tmp/soundsible-s2t-auth-isolated.log`. Ruff/diff pass.

Repeat main suite/restart on final sources. The last global green is still S2q;
do not present the scoped fix as a full regression. S2u OS selector has a
separate contract/draft, it is not part of these eight tests or of this acceptance.
