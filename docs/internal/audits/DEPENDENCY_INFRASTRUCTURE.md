# Block 2 · Dependency infrastructure

Initially validated separately in PR #346, on main after PR #345.
It is incorporated into the clients/Python set in PR #347 to validate and merge
a single combined head. It does not deploy services or publish releases.

## Changes

- Actions: checkout 7.0.1, setup-node 7.1.0, setup-python 7.0.0,
  setup-java 6.0.1, cache 6.1.0, upload-artifact 7.0.2,
  download-artifact 8.0.2 and attest-build-provenance 4.2.2.
- Docker Actions: buildx 4.4.1, QEMU 4.4.0, login 4.6.0,
  metadata 6.2.0 and build-push 7.4.0. Also paths-filter 4.0.3,
  setup-gradle 6.4.0, setup-android 4.0.4, emulator-runner 2.38.0,
  rust-cache 2.9.2 and action-gh-release 3.0.3. The inputs,
  permissions and gates of the workflows are kept; Gradle/AGP is not migrated.
- MediaMTX 1.21.2 in Compose and in the Android fixture, with the SHA-256 of the
  official Linux x64 archive updated together.
- Coturn 4.18.0-r0 in the three services. This version removes `--no-dtls`:
  DTLS is now disabled by default and is only enabled with `--dtls`.
  The removed option is dropped without enabling DTLS. The CLI is also off
  by default. Reference: [4.18.0 notes](https://github.com/coturn/coturn/releases/tag/4.18.0).
- FFmpeg from the 8.1 line, monthly build 8.1.3 of 30 September, in CI
  and in desktop packaging, except Windows ARM64. The new build fails
  in the native smoke test when generating FLAC audio with STATUS_ACCESS_VIOLATION
  (run 38149650880); that target keeps the already verified 8.1.2 pin from July.
  The hashes of the four Linux/Windows, x64/ARM64 candidates were verified;
  a correct checksum does not prove binary compatibility. Linux stops downloading a floating master without a checksum;
  ARM64 selects its correct archive. FFmpeg 9 is outside this delivery.

## Local validation

- actionlint 1.7.12 on all workflows; Bash syntax, Ruff on the fixture,
  `docker compose config --quiet` and `git diff --check` passed.
- Download and SHA-256 of the four FFmpeg archives checked. The packaging
  script installs Linux x64 ffmpeg/ffprobe; 10 runtime and
  loudness tests passed using those binaries. Windows is validated through CI.
- MediaMTX starts with the real LiveFixture configuration and its ephemeral
  certificates. The API returns 200; Community returns health 200 with healthy SQLite and
  MediaMTX, using the new Python pins from block 2.
- Coturn in isolated containers, listening only on loopback: TURN REST HMAC
  authentication, relay-only allocations and bidirectional traffic
  passed over UDP, TCP and TLS. TLS verifies the certificate with the ephemeral CA;
  the key has the read permissions documented for the container.
  The first test detected the removed option and it was fixed before opening
  the PR. No production credentials or services are used.

The checks of the latest head of the PR must pass before this delivery is considered
finished. The four Android shards check the new relay over HTTP/TLS;
Desktop Build checks the Windows binaries. Updating the release Actions
does not run a local release or test the permissions of a real publication.
AltStore PAL remains unverified: the paid Apple account needed
to run that path does not exist and its notices are kept.
