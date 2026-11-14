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
| 3 | Socket.IO accepts any origin | Pending |
| 4 | Server playback queue that no client reads; stub routes | Pending, needs a decision |
| 5 | Business logic in route modules and in the Flask module | Pending |
| 6 | State JSON files written without protection against power loss | Pending |
| 7 | yt-dlp update with the module already imported | Pending, not reproduced |
| 8 | Dead code and minor details | Partial: `gui.sh` removed; rest pending |
| 9 | Musical identity coupled to hash/video and rebuilt in each client | Implemented in PR #423; pending CI and integration |

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

### 3. Socket.IO accepts any origin

`_socket_cors_origins = "*"` (`shared/api/__init__.py`) while REST uses
`_build_cors_origins()`. Without a password and in daemon mode, `on_socket_connect`
accepts the socket without looking at the IP, so any page open in a
browser that reaches the engine receives `library_updated`, `downloader_*` and the
playback events.

Be careful when fixing it: in `python-engineio` 4.13, a **list** of origins
replaces the same-origin check (`HTTP_HOST` and
`X-Forwarded-Host`). Passing the REST list would break the player served at
`https://maquina.tailnet.ts.net` or behind a proxy. A function
`(origin, environ)` must be passed that accepts the same origin (as engineio does with `None`)
**or** the REST patterns. Native Android (OkHttp) does not send `Origin`, and engineio
checks nothing without that header. Test with the four
Playwright profiles and with `tailscale serve`.

### 4. Server playback queue

`player/queue_manager.py` and `/api/playback/queue*`, `/shuffle`, `/repeat`,
`/next`: no client (web, Android, iOS) reads it. `docs/AGENT_INTEGRATION.md`
says "This is the queue the browser player consumes", and that is not true: what an
agent adds does not play. `GET /api/playback/next` modifies state with a GET.
`/api/playback/play` always responds 404 and `/api/playback/toggle` always 500:
leftovers of the removed server player. User decision: delete the
queue and its routes (and the section of the agents guide) or connect it to the
players. The two stubs can be deleted now.

### 5. Layers

`_resolve_candidates` is private to `shared/api/routes/catalog.py` and is imported by
`auto_mode.py`, `library.py` and `shared/migration/service.py`.
`shared/dj/session.py` imports `_dj_prepare_cohort` from `routes/auto_mode.py`.
`catalog.py` imports `_get_preview_stream_cached` from `routes/playback.py`. The
shared objects (`get_user_core`, `add_tracks_to_user_library`,
`emit_to_user`, `socketio`) live in `shared/api/__init__.py`; that is why nine
blueprints have their own `_get_api()` with deferred imports and
`shared/loudness/service.py`, `shared/migration/service.py` and
`shared/artwork_recovery.py` import the Flask module. Moving those functions to
service modules is mechanical. The tests replace `_get_api` with
dictionaries: moving them requires updating those doubles.

### 6. Non-atomic JSON writes

`player/queue_manager.py` (`queue_state.json`), `shared/playback_state.py`
(on each `PUT /api/playback/state`) and `shared/discovery_intelligence.py`
(`discovery_settings.json`) use `write_text`. A power loss during the write
leaves the file truncated. `favourites_manager` now uses the SQLite collection (PR #423)
and `shared/atomic_file.py` exists. If the queue from item 4 is deleted, two are no longer needed.

### 7. Hot yt-dlp update (not reproduced)

With `YTDLP_AUTO_UPDATE`, `start_api` launches `pip install --upgrade yt-dlp` in
the background when `yt_dlp` is already imported (checked: `import shared.api`
loads it). The installed version ships `lazy_extractors.py`: on import only
4 extractors are loaded, and the YouTube one is imported on first use, from the
new files, alongside the old core in memory. Fix: update before
importing or restart after updating.

### 8. Dead code and minor items

- **Closed:** removed `gui.sh`, which only printed that the GTK player had been
  removed and recommended `python run.py`. It had no consumers in the repository.
- 35 icons in `desktop-shell/src-tauri/icons/ios` and `icons/android` that
  `tauri.conf.json` does not reference.
- `stream_local_track` returns the absolute path in the 404
  (`shared/api/routes/playback.py`); `/api/health` hides paths on purpose.
- `docs/internal/ARCHITECTURE.md` §5 still lists `<config>/download_queue.json`; the
  download queue is in `instance.db`.
- The `rate_limit` limits use `request.remote_addr`: behind a proxy
  all clients share a bucket. They could use `request_client_address()`,
  taking care not to let a client choose its own key.
- `get_request_auth_context` stores the context in `g` without taking
  `allow_trusted_network` into account. Today it does not fail because all callers pass `True`,
  but the parameter has no real effect.


## 9. Collection identity (PR #423)

The "2 songs" incident with one row mixed a YouTube reference and a file
with a hash: saved items deduplicated their sources, but playlists searched only by
`track.id`. The PR replaces that architecture with stable musical items,
persisted source relations and a single transaction for incorporation and
membership. Web/Android/car/iOS consume the identity without retargeting prepared
or offline audio. Contract, migration and acceptance in
[COLLECTION_IDENTITY](COLLECTION_IDENTITY.md). It does not close items 3–8.
