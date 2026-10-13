# Cloud CI runtime

GitHub-hosted runners remain the merge validation environment. No suite moves
to a developer machine, and no test or deployment smoke check is removed.

## Baseline

Job and step durations from GitHub's Actions API on 2026-10-13:

| Run | Workload | Observed duration |
| --- | --- | --- |
| 38416233386 | Android development | Slowest shard 22m21s; static job 4m27s |
| 38416233380 | Windows installers | x64 20m06s; ARM64 16m03s |
| 38416233180 | Core PR CI | About 7m; Python coverage step 6m36s |

Android's principal suite assigned 40/50/67/58 cases to the four emulators.
The slowest shard spent about 16 minutes executing its cases. The uploaded
JUnit evidence contains 215 unique principal cases, plus separate smoke and
process-restart evidence. More runners reduce serial device work without
shortening playback observations or weakening assertions.

Windows x64 spent 11m57s in Tauri bundling, and both architectures missed their
Rust cache. Cache misses are observed; their individual cause is not proven.
The repository cache snapshot contained about 3.25 GB of Rust, 3.49 GB of
BuildKit and 3.83 GB of Gradle content across branch/tag scopes. Isolated PR/tag
caches cannot seed the next unrelated PR and compete with reusable main entries.

## Changes

- Eight Android emulators run the same instrumentation suite. Shard zero keeps
  offline smoke and ordered process-restart protocols. The release gate requires
  all eight check names; a regression test compares it with the workflow matrix.
- Enable Gradle task caching in Android CI. Static and emulator shard zero seed
  main's shared cache; the other emulator jobs only read it. Device tests still
  run on every job, including when compilation tasks are reused.
- Rust and Docker caches are written only on main. PRs and release tags still
  read matching main caches, compile current sources and execute their checks.
- Build the ARM64 Docker image on GitHub's native Ubuntu ARM runner, concurrently
  with amd64. Keep fresh upstream pulls, the nightly cache-free build, dependency
  lock verification and amd64 Compose deployment smoke.

The larger emulator matrix can encounter runner queueing under overlapping
workflows. Validate wall time and all cases on the PR, rather than assuming
that doubling shards halves total CI duration. Windows cache improvements need
subsequent runs to establish a stable benefit; a single warm run is insufficient.
