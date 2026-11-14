# Cleanup of legacy code without consumers

Inspected base: `origin/main` at `4131f7f0`. The user asks to keep the
current behavior and leave an open PR, without merge. The scope is fixed
through references, imports, entry points, documentation and tests;
the absence of a call inside the application is not enough to delete a
public API, a CLI command or a tool for reproducing results.

## Changes

- **Artwork:** the extractor keeps the original and its addition to the store.
  The generation of `*_thumb.jpg` and its two readers without calls are removed.
  Responses still use the `ArtworkStore` variants, with the same
  dimensions, revision, quota and open descriptor. Existing files are not deleted
  and references to originals are not changed.
- **Diagnostics:** the automatic production capture delivers and persists the
  same rows, but no longer also retains the manual history of 4,096 events.
  The manual capture and development mode keep that history for the
  browser and diagnostic tests. Sequences, batches, retries, losses,
  ACK, account isolation and opt-out keep their contracts.
- **DJ:** `shared/dj_library.py` is removed, whose startup had been removed in
  P14, together with its three historical tests and the inactive global monkeypatch.
  Session jobs, the analyzer process, the analysis version and the
  musical measurements remain intact.
- **Orchestrator:** `submit_metadata` and its executor without production
  submissions are removed. The background pool, the supervisor and `run_serialized` keep their
  limits and locking. The shape of the resource snapshot keeps the
  `metadata` entry with the zeros it already returned in production.
- **Removed local player:** the variable that was always `None` and its
  impossible branches are removed. `get_core` keeps the triple with `None` in second position.
  The public play/toggle routes keep their 404/500 errors and agents
  without a device keep 409. Remote control and the first-play beacon
  remain available through their current paths.
- **Frontend:** the disconnected modules `trackResolution` and
  `mobile/catalogProgram` are removed, along with API wrappers without calls, their exclusive types,
  old result conversions, the mobile queue state that nobody opened,
  two icons and helpers without consumers. The server endpoints, the
  job-based migration and the deferred resolution of collections are kept.
- **Python helpers:** the unreferenced methods for storage
  disconnection, album lookup by name, bucket size calculation,
  stream and downloader warm-up, resolution executor, route-to-user
  mapping, admin request, sessions, active socket, cache usage and two launcher
  helpers are removed.

The commands `python -m shared.instance_backup`, the engine stop
helper used by the smoke test, the reproduction entries of the
detector comparison and the functions used to inspect state in
tests are kept. No migrations are added and user data is not modified.

## Desktop Build failure on main

Run [41502159498](https://github.com/Arzuparreta/soundsible/actions/runs/41502159498):
the binaries, installers and sidecar smoke test were built correctly.
The x64 UI smoke test timed out with the WebView window blank; ARM timed out
waiting for a button with the Windows privacy OOBE in front. Afterwards ARM
also failed when querying Rekor with a network timeout.

The smoke test uses WebView2 software rendering only in its test process,
waits for controls to be ready and handles the OOBE during all those waits, not only
after opening the folder picker. Failures attach the UIA trees in addition
to the screenshot. Two isolated tests cover the OOBE/late startup and that
unexpected UIA errors are not hidden.

The first verification run confirmed the smoke test and the x64 attestation. On ARM,
the OOBE was now closed, but Explorer kept the foreground: the physical
click on "Use this computer as server" activated another application and Soundsible
stayed on the connection screen. The screenshots and UIA trees showed this.
The initial actions go through UIA Invoke, as Continue and the
reopening of the picker already did, to act on the Soundsible control even if
another window covers its coordinates.

The attestation retries once. If the second attempt fails, the job fails;
the attestation is not suppressed and an installer is not published without it. The real
Windows run is checked in the PR; this Linux machine does not replace that test.

## Validation

The checks run with isolated test runtimes and servers.
The user's engine is not restarted and their library is not used.
The PR records the final result of Python, frontend, the four
browser profiles, lint and the remote checks of the last head.
