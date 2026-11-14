# S4e — Visible Live and native guest

The app opens Live from its navigation. The Solid UI sends the service the commands
to broadcast, rename, end, listen, pause/resume, change volume, send
chat and leave a room. Closing the panel only removes observers; it does not end the
session and does not depend on a JS timer to keep broadcasting or audio.

The directory is obtained through `NativeLiveDirectory`, from the HTTPS relay
selected by the Core: bounded JSON, no Core cookies sent to Community, no
redirects, limited worker and results tied to generation. The WebView keeps
its policy of blocking remote JSON. The UI refreshes the visible directory and after
mutations, without overlapping queries. An extended test discovered the wrong fetch
path and led to this bridge; the WebView interceptor was not relaxed.

`NativeCommunitySocket` keeps the guest in the service, receives programme/chat/
presence/end and updates MediaSession metadata. Guest chat and controls go
through the private command of the same UID. Listening hides queue, lyrics, DJ and autoplay
as song actions; the canonical selection still returns to NORMAL.

The extras and responses to JS remove host/publication tokens. A 401 observed
by Core Live actions returns expired authentication and clears session/profile;
the UI returns to login and removes library/panel. The Socket.IO transports allow
20 s long polling without the previous 10/20 s timeout; a targeted soak is still pending.

See `evidence/s4e.json` for final tests/logs and source provenance.
The block combines Native Host/Guest/Relay/Input acceptance with real HTTP/TLS UI.
The UI performs broadcast/title/chat/end and directory/PCM listening/pause/volume/chat/leave;
the extension checks login after 401. Full unit tests and TypeScript accompany
the validation. It does not replace Browser4 or the main regression before the PR.

Live pending: full DJ to the relay and transition metadata, public artwork,
media/network/lease recovery, reset during handshake and process death. There is no
acoustic acceptance on hardware, Bluetooth or car. It also does not enable alpha, merge
or publication; the final PR is left for manual review.
