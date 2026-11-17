# Web design system

The shared primitives and pattern implementations live in `ui_web/src/design`.
Existing imports from `components/Button`, `components/CoverImage` and
`components/MusicListRowView` are compatibility exports, not competing recipes.

- `Control` keeps native button semantics and defaults to `type="button"`.
  `IconButton` requires a label. `Button` adds the standard visual variants.
- `Field` and `Select` require an accessible name and retain native input and
  selection behavior. `Tabs` owns one keyboard stop, arrow/Home/End navigation
  and selected-tab semantics.
- `MediaRow` is the platform-neutral visual row. Browser and native adapters
  supply state and actions. A reused collection slot reads its item through an
  accessor; any local state must follow musical or occurrence identity.
- `ArtworkImage` handles fluid cards, source sets, decode hints and failed-image
  fallback. `ArtworkSurface` handles fixed row slots without a size observer.
  Both consume resolved artwork URLs and the shared identity/fallback helpers.
  File covers request thumbnail variants in rows; full-player artwork is larger.
- Row height, artwork and controls follow `--row-h`, `--cover-sm` and
  `--control-h`. Panel fields follow the same density recipe. Loaded browse
  grids and skeleton grids use `--browse-grid-columns` and the browse gap tokens.
- Context popovers, sheets, drawers and dialogs belong to the single overlay
  registry. They share disposal, stacking, navigation dismissal and focus return.
  Popovers retain cursor/control placement and arrow-key navigation. Pass the
  `MenuEvent` through adapters, including Shift+F10; a touch hold has no event
  and opens the action sheet. Selecting an action closes the menu and restores
  its opener before opening the next surface.

## Navigation decision (U4)

Keep the canonical entity page under Search, including its library view. Artist
and album pages let the listener explore one entity through library/discovery
views; they do not change their navigation owner with their incoming link.
Browser Back and retained navigation stacks preserve the originating place.
This keeps the existing deliberate behavior and its browser coverage. No
unmeasured origin-propagation scheme is introduced as a rendering fix.

## Enforcement

`npm run design:check` parses JSX and CSS. New raw native controls outside the
primitive allowlist and new literal style debt outside tokens/recipes fail.
The per-file legacy baseline is `ui_web/scripts/design-baseline.json`; removing
debt in one file does not grant another file permission to add it. The gate runs
locally with `npm test` and in CI's `ui_build` job. To reduce the baseline after
a migration, run `node scripts/check-design.mjs --update` and review its diff;
CI never updates it.

`tests/browser/design-system.spec.ts` covers the actual player browser in dark
and light themes at Compact, Normal and Large on each CI browser profile. Its
reviewed screenshots cover field, tabs, typography, artwork and visible row
menus. It also checks menu keyboard anchoring/focus and tab keyboard behavior.
These fixture views never contact a real engine or library.
