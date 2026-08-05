# Changelog

All notable changes to Soundsible are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version a running instance reports comes from `shared/version.py`.
`GET /api/health` returns it, and Settings → About shows it.

## [Unreleased]

### Added

- Multi-architecture container images published to the GitHub Container
  Registry for `linux/amd64` and `linux/arm64`, with signed build-provenance
  attestations. `main` publishes `edge`; a `v*` tag publishes the semver tags
  and moves `latest`.
- `compose.build.yaml`, a build override for developers and CI.

### Changed

- Installing no longer requires a checkout or a build toolchain:
  `docker compose up -d` pulls a published image. `compose.yaml` has no
  `build:` section, so it can never start compiling on hardware that cannot
  afford it.
- One version for the whole engine. Four call sites each defaulted to
  `0.0.0-dev` independently and the container defaulted to `0.0.0-docker`;
  everything now reads `shared.version.resolve_version()`.

## [0.1.0] — unreleased

The first version under a single coherent version number. Earlier tags
(`v0.0.1`, `v0.0.2`, `0.0.3`, `desktop-v0.1.0-beta.*`) predate it and did not
share one.

Soundsible before this point already had: a SolidJS Station player with an
Auto Mode DJ that beat-matches transitions, Live WebRTC broadcasting to a public
hub, multi-user accounts with invites and scoped tokens, YouTube / YouTube Music
/ Deezer / MusicBrainz catalog search and acquisition, podcasts, synced lyrics,
EBU R128 loudness levelling, free-lossless upgrades verified by AcoustID
fingerprint, Spotify and Apple Music import, QR device pairing, cross-device
playback handoff, and a Tauri desktop shell.

[Unreleased]: https://github.com/Arzuparreta/soundsible/compare/main...HEAD
