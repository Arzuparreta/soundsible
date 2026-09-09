# Repository instructions

- Every completed implementation in Soundsible must end with a git commit. The
  user does not create these commits manually.
- Commit only the changes that belong to the completed task unless the user
  explicitly asks to include other working-tree changes.
- All work in Soundsible reaches `main` through a pull request from a branch —
  never commit to `main` directly.
- Before opening any pull request, fetch its target branch from GitHub and
  verify that the working branch contains that latest remote base. For the
  usual `main` target, run `git fetch origin` followed by
  `git merge-base --is-ancestor origin/main HEAD`. Use the actual remote and
  target branch when they differ; a local `main` or an earlier fetch is not
  evidence that the base is current. If the fetch fails or the ancestry check
  fails, do not open the PR yet. Incorporate the updated base into the task
  branch, resolve any conflicts without dropping either task's changes, run
  the checks appropriate to the combined changes, commit as needed, and push.
  Fetch and repeat the ancestry check immediately before `gh pr create`, and
  ensure the PR's remote head matches the verified local `HEAD`. Do not rely
  on CI to discover that the branch was already stale when the PR was opened.
  The base can still advance afterward: repeat this check before merging and
  after merging another PR into the same base; update and revalidate as needed
  rather than bypassing GitHub's required checks.
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
- **The AltStore PAL path has never been executed.** `.github/workflows/ios-altstore-pal.yml`,
  `ios/exportOptions/app-store-connect.plist` and the `--marketplace-id` half of
  `scripts/altstore_source.py` were written from documentation, not from a
  working run: distributing through an EU marketplace needs a paid Apple
  Developer account and there is no account. Passing CI proves nothing about
  them — nothing in CI can run them. Do not describe that path as working, do
  not build on it as though its details were confirmed, and keep the "not
  verified" notices in place until somebody has actually shipped through it.
  `docs/IOS.md` records which line came from which document, and which ones are
  outright guesses. The sideloading path (`ios-build.yml`) *is* verified: it
  builds a real IPA on every run.
