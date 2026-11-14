# S2m: NORMAL Radio owned by the service

Radio generates music recommendations through `/api/discovery/music/plan`; it is not
a catalogue of stations. The service keeps seed, profile, recent history,
cancellable request and timers while the WebView is not active.

Enabling it on the current song keeps its occurrence, position and pause
intent. The planner adds candidates after what was requested manually; manual append
inserts before the first future recommendation. Stop Radio removes only its
future occurrences, keeping the current song and manual insertions. Changing
profile cancels and replans from the current song. Replacing the programme or closing it
cancels the planning on the same looper of the service.

Maximum lookahead eight, refill when five or fewer remain; deduplication against the real
queue and a bounded history of eighty IDs. Response and metadata have limits;
reject unknown source, invalid preview ID, oversized metadata or podcasts.
Temporary retries at 2/5/15/30/60 seconds with bounded Retry-After; player
events do not bypass the wait. Auth/permissions are not automatic retries.

Radio state and preview share session extras without erasing each other. The bridge
only returns state/metadata, without cookies or provider addresses. The
replaced queue is confirmed over IPC, including a new occurrence token for a replay
with identical IDs; the command acknowledgment alone does not demonstrate an updated snapshot.

Tests: real local pool/planner/final stream with synthetic files; the fixture
adds data only when its private endpoint is requested and preserves the rest of the tests.
HTTP/HTTPS APK must confirm stable seed, pause/position, manual row,
deduplication, Activity recreation and Stop Radio. Add real refill/background,
failures/Retry-After, cancellation/account and UI parity before considering Radio closed.

This document describes implementation in progress, not full acceptance. See
HANDOFF for final evidence. Autoplay, direction/DJ, Live, Auto, complete actions,
signing/update and publication keep their independent gates. Continue until
parity; no checkpoint authorizes a partial alpha or finishing the user's task.
