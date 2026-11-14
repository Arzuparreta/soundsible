# S4i — Resume room and program after another publisher/process

A 409 `session_already_active` from Core leads to a signed resume of that room. Before
rotating tokens, Community queries its private MediaMTX API and removes only the
WebRTC publisher whose path and identity match the stream of its verified
owner. A relay failure returns 503 without invalidating the current credentials.
The control API stays private; no public action to cut peers is exposed.

Resume invalidates the previous host socket and keeps room, artwork and last program.
The new host continues its sequence from the previous snapshot. The native cleanup
includes a signed `if_host_token`: a late operation with the previous token
receives 409 and does not delete the room of the new host. DELETE also applies an
SQL condition to protect the race with another resume.

Process continuity is tested in two phases on the same installation:
prepare keeps a broadcast of the service, the runner does force-stop and resume
checks a different PID, encrypted Core cookie kept, same room, increasing sequence
and independent PCM received through WHEP. Resuming is explicit: the user
selects music and taps Go live; starting the process does not publish by itself.

`android.py integration --live-restart-only` runs only that protocol with an isolated
relay and keeps results separate from the main regression. The main run
excludes the two-phase test and afterwards runs both protocols, offline and Live, without
reinstalling or recompiling between prepare and the restart of each one.

Core19/0; LiveResume HTTP/TLS2/0 (16.256s); restart prepare1/0 (5.935s) and
resume1/0 (5.277s) accepted. Both runners exit0 and normal APK/test APK/JVM56/lint
without temporary CA. Evidence: `evidence/s4i.json`.
Still missing: targeted reset/exhaustion/focus and final Live regression, in addition to
the remaining phone/DJ/Auto/signing rows. PR only for manual review.

Relay contract pinned by the deployment: [OpenAPI MediaMTX](https://raw.githubusercontent.com/bluenviron/mediamtx/v1.19.3/api/openapi.yaml).
Correction of earlier documentation: Community sends a ping every 20s and allows 25s
for the pong. The silent 35s test crosses the 20 interval, not 25.
