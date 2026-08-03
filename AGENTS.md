# Repository instructions

- Every completed implementation in Soundsible must end with a git commit. The
  user does not create these commits manually.
- Commit only the changes that belong to the completed task unless the user
  explicitly asks to include other working-tree changes.
- All work in Soundsible reaches `main` through a pull request from a branch —
  never commit to `main` directly.
- Never run `npm run build` in `ui_web/`, and never end a turn telling the user
  to rebuild to see their changes. `ensure_ui_dist()` rebuilds `ui_web/dist`
  from the boot sequence and on every page render, so the running engine is
  already serving the current sources. Local checks are `npm test`; CI's
  `ui_build` job covers the bundle.
