# Playback transport under background load

The isolated harness uses the production local HTTP Range handler, gevent patch
order, real canonical edits and portable exports, filesystem reads/hashing and
DJ analysis of a synthetic PCM file. It creates fresh temporary runtime/cache
roots on the repository filesystem. No real library, live service or provider
is touched. HTTP clients verify every returned range against the source bytes.

```sh
PYTHONPATH=. .venv/bin/python scripts/benchmark_playback_load.py \
  --scenario loaded --tracks 1000 --clients 2 --seconds 60
PYTHONPATH=. .venv/bin/python scripts/benchmark_playback_load.py \
  --scenario loaded --tracks 200 --seconds 10 --blocking-fsync
```

Scenarios are `idle`, `normal`, `loaded` (edits and filesystem scanning) and
`dj` (loaded plus six cold analysis requests). `--profile hdd` exercises the
single-worker admission profile; it does not emulate another physical disk.
Finite jobs use the real orchestrator, so the HDD profile runs both workloads.
There are no synthetic sleeps *inside* measured filesystem/database work.
Pacing between operations and requests defines offered load.

The `--blocking-fsync` control replaces only the flush helper with its prior
synchronous implementation. Application code otherwise remains identical.
Results record source hashes, elapsed time, verified range latency, event-loop
lag, process CPU/PSS, physical write counters, queue occupancy and completed work.
Fresh application caches do not mean an OS cold disk cache. Compare cases on an
otherwise quiet host; do not run test suites concurrently with measurements.

## Change justified by the measurement

Portable exports called `os.fsync` on the gevent hub. Slow durable flushes stopped
unrelated requests even though playback did not acquire the library write lock.
Patched engine processes now wait cooperatively for a native worker to perform
that same fsync. Publication still waits for success, then renames; fsync errors
preserve the previous file. A duplicated descriptor belongs to the worker, so
cancelling the caller cannot close/reuse a descriptor under an active flush.
Unpatched CLI processes keep the direct implementation.

The orchestrator exposes an aggregate `resource_snapshot()` without retaining
completed job histories. Cancelling a queued future now clears its identity and
timing record so a replacement job can be admitted. Pools remain independent;
no arbitrary priority policy or queue eviction was introduced.

## Evidence and limits

[Raw matrix](playback-load.jsonl) contains alternating control/candidate runs,
idle and normal transport, cold DJ analysis, HDD admission, and a one-minute
loaded run. See the audit summary for measured comparison and final validation.

These are HTTP transport and server scheduling measurements, **not audible
playback or battery measurements**. Authentication/core/path lookup are bound to
the isolated fixture; production streaming and Range response generation run
unchanged. The filesystem workload hashes the fixture, not a full folder-import
pipeline. Remote downloads, slow providers, browser foreground/background,
NORMAL/DJ handoff correctness, Live and physical iPhone/CarPlay acceptance are
not represented. Those require separate workloads/devices. SQLite, JSON work,
FFmpeg and other synchronous paths can still produce hub stalls. This change
removes the measured export-flush cause; it does not guarantee zero stalls.
