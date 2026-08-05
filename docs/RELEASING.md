# Versioning and releases

Soundsible has one version number. The server, the container images and the
desktop app are built from the same commit and released together, so `0.2.0`
means the same thing however you installed it — and a bug report only ever has
one number to quote.

## What the number promises

The version describes what happens to **you** when you upgrade. Not internal
APIs, not how much code changed.

| Change | Means |
| --- | --- |
| **MAJOR** | Upgrading requires you to do something by hand: edit your compose file, rename a setting, migrate data, or adapt to a changed API |
| **MINOR** | New capability. Upgrading is still `docker compose pull && docker compose up -d` and nothing else |
| **PATCH** | Fixes only |

While Soundsible is below 1.0 there is no major number to spend, so **minor
carries what major will carry later**: a 0.x minor may ask something of you.
Patch never does, at any point.

`X.Y.Z-rc.N` is a release candidate — built and published like any other
release, marked as a pre-release, and never moves the `latest` container tag.

### What 1.0 will mean

Not "it feels finished". Two specific things, both of them on the
[roadmap](ROADMAP.md) and both of them engineering:

- The OpenSubsonic API is stable enough that third-party clients can depend on
  it without pinning a version.
- The library lives in SQLite as the source of truth, and upgrades migrate it
  forward without anyone touching a file.

Until then, 0.x is the honest answer.

**The desktop app is not on that list**, and its beta status does not hold
1.0 back. What stands between it and a stable label is a Windows code-signing
certificate — money and a legal identity, not code. Soundsible will not buy
one; if the community wants signed Windows builds enough to fund it, the
release workflow gains a signing step and nothing else changes. Until then the
installers ship unsigned, with build-provenance attestations, and Windows will
warn about an unknown publisher. That is a fair trade for a beta and a bad one
for something called stable, which is why [the beta gates](DESKTOP_BETA.md)
still say an unsigned build must not be published as stable.

The desktop app carries the same version as everything else regardless. `0.4.0`
is `0.4.0` whether you installed it as a container or as an app; "beta" is a
statement about the desktop shell's maturity, not a separate number.

## Where the version lives

`shared/version.py` declares it. That is the only place it is decided.

The engine imports it. The container image gets it as a build argument from
the tag. The desktop shell is the awkward case: Cargo, npm and Tauri each read
their own manifest at build time and none of them can read Python, so the
number is copied into five places by `scripts/version_sync.py`:

```
desktop-shell/src-tauri/tauri.conf.json
desktop-shell/package.json
desktop-shell/package-lock.json      (twice: root, and packages[""])
desktop-shell/src-tauri/Cargo.toml
desktop-shell/src-tauri/Cargo.lock
```

Copies drift, so CI's `version_consistency` job runs
`scripts/version_sync.py --check` on every push and pull request and fails if
any manifest disagrees. On a tag it also fails if the tag and the declaration
are different numbers.

This is not hypothetical: before it existed the manifests said `1.0.0-rc.1`
while the engine said `0.1.0`, and every installer ever built reported
`1.0.0-rc.1` no matter which tag produced it.

## How the number is chosen

By the pull requests, as they merge. Every pull request carries exactly one
impact label, added when it is opened:

```
impact:major   they have to do something by hand to upgrade
impact:minor   new capability, upgrading is still just a pull
impact:patch   a fix
impact:none    nothing a user could observe (docs, CI, tests)
```

The `impact_label` check rejects a pull request without one. Releasing then
takes the highest label merged since the last tag and moves the number
accordingly — nobody re-reads a month of diffs trying to remember whether
something was breaking.

## Cutting a release

```bash
python scripts/release.py plan       # what would go out, and as what number
python scripts/release.py prepare    # opens the bump PR, auto-merge armed
#   ... it merges once the required checks pass ...
python scripts/release.py finish     # tags the merge commit
```

Or `/release` in Claude Code, which runs the three steps and waits in between.

`prepare` opens a pull request instead of pushing to `main` because the branch
ruleset forbids direct pushes — the release goes through the same gate as
everything else. It runs from a checkout rather than from Actions because a
`GITHUB_TOKEN` push triggers no workflows: a bot-authored bump would never
receive its required checks, and a bot-pushed tag would build nothing.

`--rc` cuts a release candidate. `--version X.Y.Z` overrides the derived
number, which is how 1.0 will eventually happen — a label cannot decide that.

## What a tag builds

Pushing `vX.Y.Z` starts two workflows:

- **CI** builds and pushes the container images to GHCR: `X.Y.Z`, `X.Y`, and
  `latest` (stable releases only — a release candidate never moves `latest`).
- **Release** verifies the tag against the declaration, builds the Linux
  `.deb` and the Windows x64 and arm64 installers, and publishes one GitHub
  Release with all of them attached and generated notes.

Every push to `main` also publishes a `edge` image, which reports
`0.0.0-edge+<sha>` so two edge builds are never confused for each other.
