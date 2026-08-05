---
description: Cut a Soundsible release from the impact labels of what has merged
---

Release Soundsible. The version number is derived, never invented: it comes
from the `impact:` labels on the pull requests merged since the last tag.

$ARGUMENTS may contain `--rc` (cut a release candidate) or
`--version X.Y.Z` (override the derived number — only for deliberate moves
like reaching 1.0).

1. `python scripts/release.py plan $ARGUMENTS` — show the user the number and
   what is going into it. If any merged pull request has no impact label, say
   so plainly: it is being counted as a patch and that may be wrong.
2. `python scripts/release.py prepare $ARGUMENTS` — opens the bump pull
   request with auto-merge armed.
3. Wait for it to merge. It needs the same required checks as anything else,
   and it touches `shared/**`, so the container builds run: expect this to
   take a while. Poll with `gh pr checks <url> --watch` or come back to it.
4. `python scripts/release.py finish` — tags the merge commit and pushes.
   That tag is what builds the images and the installers and publishes the
   GitHub Release.

Report the release URL when it exists. Do not hand-edit a version anywhere:
every version in this repository is written by `scripts/version_sync.py`.
