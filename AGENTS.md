# Repository instructions

- Every completed implementation in Soundsible must end with a git commit. The
  user does not create these commits manually.
- Commit only the changes that belong to the completed task unless the user
  explicitly asks to include other working-tree changes.
- All work in Soundsible reaches `main` through a pull request from a branch —
  never commit to `main` directly.
- Every pull request carries exactly one impact label, set when you open it:
  `gh pr create ... --label impact:minor`. It answers "what does merging this
  do to someone who upgrades?" — `major` they must act by hand, `minor` a new
  capability that still upgrades cleanly, `patch` a fix, `none` nothing a user
  could observe. Release numbers are derived from these labels, so an
  unlabelled pull request ships as a patch whatever it actually did. CI
  rejects a pull request without one.
- Never write a version number by hand, anywhere. `shared/version.py` declares
  it and `scripts/version_sync.py` propagates it to the desktop manifests;
  releases are cut with `scripts/release.py` (see `docs/RELEASING.md`).
- Never run `npm run build` in `ui_web/`, and never end a turn telling the user
  to rebuild to see their changes. `ensure_ui_dist()` rebuilds `ui_web/dist`
  from the boot sequence and on every page render, so the running engine is
  already serving the current sources. Local checks are `npm test`; CI's
  `ui_build` job covers the bundle.
