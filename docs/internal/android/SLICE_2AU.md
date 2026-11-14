# S2au — Server settings and settings of this device

Native Settings gains the web sections that were missing: Library, Downloads
(admin only, as on the web), Community and About; Devices adds the name of
this device and paired devices (owner QR reused from the web).
The views were extracted from `SettingsSections` as shared components
(`LibrarySettingsView`, `DownloadsSettingsView`, `CommunitySettingsView`,
`AboutSettingsView`); the web uses them with its stores and Android with native
controllers scoped to account/connection.

Native controllers: each await revalidates identity and connection and aborts on an account
change. Rescan polls until complete and then syncs; repair requires an
accepted dry-run and confirmation; purge confirms; empty requires double confirmation
with the exact number. Downloads is not optimistic: it applies only after `updated` and a
re-read that confirms it. Community and versions are read from the server; About
shows app version/build and server version (`/api/health`), better than
the fixed label of the web.

Device name: previously fixed "Soundsible Android". Now it is per installation,
by default the system name (Settings → About phone) or the model,
renameable from Settings; the connected session re-registers instantly and Core
sees it without reconnecting.

SettingsServer HTTP/TLS: disposable admin account; a real rescan fills its library
and the row shows the Core count; real purge (metadata only) returns 0;
empty is exercised up to the number guard without sending the request; download
quality changes and Core confirms it (restored at the end); community/versions
match Core; renaming reaches `/api/devices` and is restored. A real
empty is not run: it would remove shared audio from the fixture.

Block Settings+Devices+Connection 22/0 HTTP/TLS, 280.499s, runner exit0 +
normal APK/test APK/JVM56/lint. WholeUI213/1631 + TypeScript.
Logs `/tmp/soundsible-settings-server-native.log`,
`/tmp/soundsible-settings-block-native.log`; evidence/s2au.json.
Pairing THIS phone by scanning a QR (claiming side, like iOS) does not exist on
the web and would be another authentication path: pending the user's decision.
