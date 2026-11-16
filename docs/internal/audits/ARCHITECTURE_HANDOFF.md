# Architecture review handoff (2026-11-05)

Entry point for continuing without the chat history. It collects what was
found while going through the engine, the web UI, the clients and CI, what was fixed and
what remains. Update the status table when you close an item.

The checks were made on `main` at `3c7e4af3`. Those marked as
**reproduced** were executed; the others come from reading the code.

## Status

| # | Item | Status |
| --- | --- | --- |
| 1 | The web metadata editor removes the song from its playlists | **Closed** in the first PR |
| 1b | Labels of one account copied to the shared pool catalogue | **Closed** in the first PR |
| 1c | Manual/removed covers shared between accounts | Fixed in the [artwork delivery](2026-11-07-artwork-requests.md): per-account overrides; ambiguous historical references preserved |
| 2 | Behind a proxy, anyone on the internet is an administrator without a password | **Closed** in the first PR (see residue) |
| 3 | Socket.IO accepts any origin | **Closed**: same origin plus the REST list (`shared/api/origins.py`) |
| 4 | Server playback queue that no client reads; stub routes | **Closed**: queue, its routes and both stubs deleted |
| 5 | Business logic in route modules and in the Flask module | **Closed**: shared services independent of the application and route-private helpers |
| 6 | State JSON files written without protection against power loss | **Closed**: whole-file replace, ordered writes |
| 7 | yt-dlp update with the module already imported | **Closed**: the daemon upgrades before importing the API |
| 8 | Dead code and minor details | **Closed** |
| 9 | Musical identity coupled to hash/video and rebuilt in each client | **Closed** in PR #423 (merged 2026-11-06) |

## Closed in the first PR

### 1. Web metadata editor (reproduced)

`ui_web/src/components/MetadataEditor.tsx` used `/api/library/tracks/<id>/metadata`,
`/cover` and `/cover/none`. All three called `LibraryManager.update_track`, which
rewrote the tags inside the file: the hash changed, the id too, and
it was saved with `_save_metadata()` without `id_replacements`. Result:

- playlists kept pointing to the old id, which no longer existed;
- `track_user_state` (plays, rating) was not moved to the new id;
- the route set `cover_source` on the old id, `_mark_track_metadata_updated`
  returned `False` without warning and the mark was lost; "remove cover" embedded
  a transparent 1×1 PNG in the audio;
- `update_track` uploaded and downloaded files from the remote provider while holding the
  global `coordinated()` lock.

Android already used `/api/library/track-labels/<id>/…` (created for this, see
`docs/internal/android/SLICE_2S.md`), which store labels in `library.db` and the cover
in the artwork sidecar without touching the audio.

Fix: `ui_web/src/lib/api.ts` uses the `track-labels` routes. The
old routes were deleted (including `/cover/from-track`, without clients, and the parameter
`cover_url`, which made the server download any URL without a size
limit), `LibraryManager.update_track`, `setup_tool/uploader.py`,
`shared/track_identity.py` and `AudioProcessor.update_tags`, which only that route used.
Intended consequence: editing a label no longer changes the tags
embedded in the downloaded file; they were private per account anyway.

### 1b. Copy of labels to the pool catalogue

`_mirror_track_into_pool` (`shared/api/__init__.py`) copied to the pool's `library.json`
the labels edited by any account. With one account this is
necessary, because that file is its library. With several it is the
instance catalogue and `run_sync_task` merges it again into the
administrator's library, so a member's label could end up in another account.
Now it only copies while `instance_has_multiple_users()` is false.

### 2. Network trust behind a proxy (reproduced)

With a single account without a password and `advanced_mode` (enabled by `--daemon` and
Docker), `_legacy_trusted_network_allowed()` gives the `owner` type with all
permissions to anyone arriving from a trusted IP. A local reverse proxy or
`tailscale funnel` made everything arrive as `127.0.0.1`. In addition
`startswith('100.')` trusted all of `100.0.0.0/8` instead of `100.64.0.0/10`.
With the Flask test client, `GET /api/users` returned 200 from `127.0.0.1`
with a public `X-Forwarded-For` and from `100.1.2.3`.

Fix in `shared/security.py`:

- `is_trusted_network` uses `100.64.0.0/10` and unwraps IPv4-mapped IPv6 addresses.
- `request_client_address()`: if the peer is trusted and carries proxy
  headers, it decides with the **rightmost** entry of `X-Forwarded-For` (the
  one written by the nearest proxy), otherwise with the last `for=` of `Forwarded`,
  otherwise with `X-Real-IP`. `Tailscale-Funnel-Request` or a proxy that names
  nobody (`X-Forwarded-Proto`/`Host` without an address) give `""`, which nothing
  trusts. Headers from a peer that is not trusted are never believed.
- It is used by `get_request_auth_context`, the Socket.IO connection, `is_safe_path` in
  playback and Subsonic, and `/api/downloader/config` (which with trust showed
  the cloud credentials unmasked).

Tailscale behaviour checked in `ipn/ipnlocal/serve.go`: `serve`
**replaces** `X-Forwarded-For` with the IP of the tailnet peer (it remains
trusted); `funnel` sets the external IP and adds `Tailscale-Funnel-Request: ?1`.

**Residue:** a proxy that sends no header (Nginx without
`proxy_set_header X-Forwarded-For …`) still looks like this machine. There is no
way to distinguish it; `docs/INSTALL.md` §5 now asks for the header and a
password before publishing the engine. Anyone who used a public proxy without a
password loses write and administration permissions through it until they
set one.

## Pending

### 3. Socket.IO accepts any origin (closed)

`_socket_cors_origins = "*"` (`shared/api/__init__.py`) while REST used
`_build_cors_origins()`. Without a password and in daemon mode, `on_socket_connect`
accepts the socket without looking at the IP, so any page open in a
browser that reached the engine received `library_updated`, `downloader_*` and the
playback events.

Fix: `shared/api/origins.py` owns one origin list for both. Engine.IO gets a
`(origin, environ)` callable, because in `python-engineio` 4.13 a **list**
replaces its own same-origin check and would refuse the player served at
`https://maquina.tailnet.ts.net` or behind a proxy. The callable accepts the
engine's own origin — scheme, host and effective port of `Host`, or of
`X-Forwarded-Proto`/`X-Forwarded-Host` written by a trusted peer — **or** the REST
patterns, or `SOUNDSIBLE_SOCKET_CORS_ORIGINS` when set (`*` still allows any
page). A TLS proxy that sends no `X-Forwarded-Proto` needs its address configured. Native Android (OkHttp) sends no
`Origin`, and Engine.IO checks nothing without that header.

Review found three more holes in the same boundary, closed with it:

- `_forwarded_client` took `X-Forwarded-For`, then `Forwarded`, then `X-Real-IP`.
  A proxy that writes `X-Real-IP` and passes the client's other headers through
  let the client choose its address (owner on a passwordless daemon, a fresh
  rate-limit budget per request). When several are present they must agree,
  or the request names nobody. Each is read as a chain from the nearest hop
  back, looking through hops on this machine, the LAN or the tailnet: with a
  public proxy at `10.0.0.2` in front of a local one, `X-Forwarded-For:
  81.2.69.160, 10.0.0.2` used to name the LAN proxy and grant the owner.
- A server-side disconnect is never retried by the Socket.IO client, so the
  socket a password change had just invalidated stayed down until a reload.
  `ui_web/src/stores/runtime.ts` reconnects once on `io server disconnect`.
- A token naming a disabled account still authenticated (disabling revokes
  only sessions; deleting revokes every token). `get_request_auth_context`
  now refuses it.
- A socket was checked only at the handshake. `recheck_sockets()` reruns the
  connect decision on each open socket's own environ every
  `SOCKET_AUTH_RECHECK_SEC` (30 s) and disconnects the ones it no longer
  admits — logout, revoked device, disabled account, expired session, or an
  instance that started requiring login. Between two passes a lapsed socket
  can still receive events for up to that long.

Checked on an engine on port 5091: polling from another origin answers 400
`Not an accepted origin`; a WebSocket from another origin gets gevent-websocket's
101 (the upgrade happens before Engine.IO runs) followed at once by a close
frame; same origin, no `Origin`, a LAN page and a `tailscale serve`-shaped
request (`X-Forwarded-Host`/`-Proto` from 127.0.0.1) connect.

### 4. Server playback queue (closed)

`player/queue_manager.py` and `/api/playback/queue*`, `/shuffle`, `/repeat`,
`/next`: no client (web, Android, iOS) read it. `docs/AGENT_INTEGRATION.md`
said "This is the queue the browser player consumes", and that was not true:
what an agent added did not play. `GET /api/playback/next` modified state with
a GET. `/api/playback/play` always answered 404 and `/api/playback/toggle`
always 500: leftovers of the removed server player.

Decision: delete rather than connect. Each player already owns its up-next list
and publishes it in `PUT /api/playback/state` (`session.queue`); a second,
server-side queue would need a merge protocol on three platforms for a feature
nobody used. Deleted: the manager, its routes, the two stubs, `QueueItem`, the
`queue_state.json` migration step and the agent guide's section, which now says
the up-next list belongs to the player. `get_core()` returned
`(library, None, queue)`; it is now `get_library()`. An existing
`queue_state.json` is left on disk and nothing reads it.

### 5. Layers (closed)

Shared services now own their collaborators outside the application package:
`shared/realtime.py` (Socket.IO and user rooms), `user_cores.py`,
`library_intake.py`, `download_pump.py`, `library_tasks.py`,
`station_addresses.py`, `memo.py`, `orchestrator.py` and `download_queue.py`.
Candidate resolution, preview streams and the Deezer catalog no longer belong
to route modules. The DJ session reports runway acceptance; its route prepares
the cohort. Services do not import the Flask application or another route's
private helper. `tests/test_layering.py` checks direct, deferred, relative and
aliased imports, including dotted attribute access.

The account boundary was checked with the move: Discover sends each waiting
request its own ranked result in its own account, even if another waiter fails;
background favourite resolution binds the saving account before creating a
downloader. Heartbeat checks import the application in fresh processes instead
of replacing singleton handlers in the test process.

Independent GPT 6.1 Sol (xhigh) review: merge; quality 8/10, complexity 8/10,
performance 9/10, maintainability 8/10 (higher is better). The four remaining
minor findings were fixed: waiter failure isolation, favourite account context,
the moved benchmark fingerprint and aliases in the layering guard. Regression
tests cover both behaviour fixes.

### 6. Non-atomic JSON writes (closed)

`player/queue_manager.py` (`queue_state.json`), `shared/playback_state.py`
(on each `PUT /api/playback/state`) and `shared/discovery_intelligence.py`
(`discovery_settings.json`) used `write_text`. A power loss during the write
left the file truncated. The queue is gone (item 4). The other two publish
through `shared/atomic_file.publish` (temporary file, fsync, rename).

Two ordering faults came with them. `put_state` wrote after releasing its lock,
so two requests finishing out of order could leave the older state on disk; each
state now takes a number under the lock and only the newest is written.
`save_discovery_settings` read, changed and wrote without a lock, so two saves at
once lost one change; it now does the three under `publication_lock`.
`PUT /api/playback/state` arrives every 15 s per playing device, so one fsync
per write costs nothing measurable.

### 7. Hot yt-dlp update (closed; the mechanism was read, not reproduced)

With `YTDLP_AUTO_UPDATE`, `start_api` launched `pip install --upgrade yt-dlp` in
the background when `yt_dlp` was already imported (checked: `import shared.api`
loads it). The installed version ships `lazy_extractors.py`: on import only
4 extractors are loaded, and the YouTube one is imported on first use, from the
new files, alongside the old core in memory. `curl-cffi`, a compiled extension,
was upgraded the same way.

Fix: `shared.runtime_updates.runtime_tool_session()` surrounds engine startup
and execution. Source daemon and desktop engines hold a shared native file
lease for their lifetime (flock on POSIX, LockFileEx on Windows). Its file is
beside the interpreter prefix, so recreating that environment cannot replace
the lock inode. Bootstrap holds the same read lease and must upgrade it before
creating, repairing or reinstalling dependencies; a running engine refuses
that mutation. The launcher retains this very lease across dependency imports
and reuses it at engine startup. A separate writer gate protects conversions
from shared to exclusive access, including failed conversions that release a
shared native lock. Only a daemon with the exclusive lease can update; another engine skips the update and joins the readers. Readers
wait for an installation already in progress before importing the API. Frozen
engines use their own bundled tools. Without file locking or access to the lease,
updates are skipped. These leases coordinate Soundsible launches, not manual pip
commands or engines from older releases.

`run.py --daemon` enters this session through `shared/engine_start.py`, before
importing `shared.api`. It refuses an update once either selected module is
loaded. Pip uses the engine's own interpreter: download wheels into a temporary
folder with a 120-second deadline, then install offline without a kill deadline.
Both subprocesses inherit the lease descriptor/handle; POSIX flock ownership
survives the parent's exit until pip finishes. Ordinary SIGINT/SIGTERM shutdown
is deferred through installation, whose subprocess has its own terminal group.
There is no promise that pip itself is transactional against external termination, disk failure or power loss. Tests exercise the real daemon
dispatch including bootstrap, replacing only external pip/API effects, and real
process contention for the shared/exclusive leases. Fresh-process tests isolate
HOME, Windows profile and XDG paths before any runtime import, and precreate
all runtime destinations. Optional lease/storage failures skip and log updates.

The standalone desktop entry takes its lease before importing any dependencies.
While it waits for an installation, it reports a startup event on its stdout
pipe; only the retained child's pipe can pause the shell's readiness budget.
No marker file must be published to keep the lock safe. Optional wait callbacks
log storage failures and still wait for the actual read lock. The shell consumes
both output pipes, resumes the budget after the wait and notices an exited
child. It accepts persisted readiness only when its PID matches that child,
never an independently launched engine's healthy state. Startup, output and
health workers carry their launch generation; readiness rechecks that generation
and retained PID after HTTP returns, so a replaced child's result is discarded.
Output is drained as byte lines with tolerant decoding, and child Python pipes
are explicitly UTF-8. Non-UTF-8 legacy logging cannot close a startup pipe.
During boot the existing status panel receives the last six child lines, making
failed native starts visible in the CI artifact's UI dump.

The Windows adapter remembers each held mode: repeated shared reads do nothing;
actual conversions run under the writer gate. A deterministic adapter regression
checks the native call boundary on every platform, and the source process tests
run on Windows. Native Rust unit tests also run in Desktop Build.

The native Windows source suite runs in Desktop Build. Rust timing, startup
event and PID tests also run independently of platform webview dependencies.
The isolated Python suite before the latest continuity/PID regressions passed:
2,964 tests, 3 intentional skips. These additional changes have targeted
regressions; the final full suite and independent re-review remain gates.

Where it does not run, on purpose: the desktop engine (a packaged build
bundles its tools, where `sys.executable -m pip` was the engine binary itself;
from source, its shell allows 120 s for the whole start), and the container,
where pip as the `soundsible` user installs into a user site directory the
running interpreter never put on its path — an upgrade reported success and
changed nothing. The container logs a warning when the setting is on.
Restarting after a background upgrade was the alternative; it was rejected
because a restart would interrupt downloads and streams already running.

### 8. Dead code and minor items

- **Closed:** removed `gui.sh`, which only printed that the GTK player had been
  removed and recommended `python run.py`. It had no consumers in the repository.
- **Closed:** 35 icons in `desktop-shell/src-tauri/icons/ios` and `icons/android`
  that `tauri.conf.json` does not reference were deleted, together with the
  Windows Store logos (`Square*Logo.png`, `StoreLogo.png`) and `64x64.png`, which
  nothing references either. `icon.png` stays: it is Tauri's fallback window icon.
- **Closed:** `stream_local_track` returned the absolute path in the 404
  (`shared/api/routes/playback.py`), and its 500 handler returned the exception
  text, which names it too. Both log the path and answer a generic message.
- **Closed:** `docs/internal/ARCHITECTURE.md` §5 listed `<config>/download_queue.json`;
  it now names the `download_jobs` table in `instance.db`.
- **Closed:** the `rate_limit` limits (and the preview-stream limit) used
  `request.remote_addr`: behind a proxy all clients shared a bucket.
  `request_rate_limit_key()` believes the forwarded client only when the peer
  is loopback (a proxy on this machine, funnel included); any other peer keeps
  its own address, so a LAN machine cannot pick a fresh key per request with
  its own `X-Forwarded-For`. A proxy on another machine still shares one bucket.
- **Closed (it did fail):** `get_request_auth_context` stored the context in `g`
  without taking `allow_trusted_network` into account. Not every caller passes
  `True`: `require_agent_scope` and `require_pairing_scope` pass `False`, but
  `before_request` had already resolved the trusted-network owner, so on a
  passwordless daemon any LAN machine used `/api/agent/*` and `/api/pairing/verify`
  without the token `docs/AGENT_INTEGRATION.md` requires. The credential is now
  memoised apart from the trusted-network owner, which only callers passing
  `True` get. The unused `g.auth_token` went with it.


## 9. Collection identity (PR #423)

The "2 songs" incident with one row mixed a YouTube reference and a file
with a hash: saved items deduplicated their sources, but playlists searched only by
`track.id`. The PR replaces that architecture with stable musical items,
persisted source relations and a single transaction for incorporation and
membership. Web/Android/car/iOS consume the identity without retargeting prepared
or offline audio. Contract, migration and acceptance in
[COLLECTION_IDENTITY](COLLECTION_IDENTITY.md). It does not close items 3–8.
