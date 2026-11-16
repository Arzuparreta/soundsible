# Connection cancellation evidence

The controlled browser scenario begins connecting to `https://music.example`,
pauses the autostart IPC, selects local setup, then releases that old IPC.
Before the fix, the old continuation still invokes the server connection and
its failure replaces local setup with the connection screen. After the fix,
local setup stays selected and no server connection is invoked.

- [Before screenshot](local-choice-before.png) and [short recording](local-choice-before.webm).
- [After screenshot](local-choice-after.png) and [short recording](local-choice-after.webm).

The production shell sources and mocked Tauri IPC are used; no real station,
account, library or network server is involved. Captured at 960 by 640 in
Chromium. The committed regressions in `desktop-shell/tests/browser/connection.spec.js`
also cover a remote error and a remembered profile completing after local selection.
