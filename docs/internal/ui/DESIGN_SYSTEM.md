# Web design system

The shared primitives and pattern implementations live in `ui_web/src/design`.
Existing imports from `components/Button`, `components/CoverImage` and
`components/MusicListRowView` are compatibility exports, not competing recipes.

- `Control` keeps native button semantics and defaults to `type="button"`.
  `IconButton` requires a label. `Button` adds the standard visual variants.
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
- `SearchField` supplies the density-aware input for every search. Use
  `PageToolbar` (via `ViewHeader` for route roots) for list and page placement.
  The field comes first and grows into the space left by metadata and controls.
  Trailing items wrap when the pane is too narrow. Use the default page gutter,
  or `contained` when the section supplies its own inset. Entity sections put
  the field between the hero and the list it filters.
- Routine routes show one page name. On touch it sits left-aligned after the
  leading top-bar control. On desktop the page indicator sits at the foot of
  the pane. Entity pages keep their heading next to their artwork.
- Context popovers, sheets, drawers and dialogs belong to the single overlay
  registry. They share disposal, stacking, navigation dismissal and focus return.
  Popovers retain cursor/control placement and arrow-key navigation. Pass the
  `MenuEvent` through adapters, including Shift+F10; a touch hold has no event
  and opens the action sheet. Selecting an action closes the menu and restores
  its opener before opening the next surface.

## Navigation decision (U4)

Artist and album detail pages are neutral: no primary navigation tab or
sidebar entry claims them (`aria-current="page"` / `aria-pressed="true"`), and
visiting them leaves every section's saved location and scroll state intact.
Back returns to the originating page through browser history (or falls back to
Home `/` for `view=library` and Discover `/search` for `view=discover` on cold
deep links). Desktop sidebar and mobile drawer entries navigate directly to each
top-level destination root (`/`, `/songs`, `/albums`, `/artists`, `/bookmarks`,
etc., climbing to root if already inside a subroute and scrolling to top on
reselection); mobile tab bar entries restore only their own real subroutes
(such as `/playlists/:name`, `/podcasts/:id`, `/settings/:section`, or
`/bookmarks/:kind`) and never absorb Songs, Albums or Artists under Home.

The URL selects the music shown and played in the detail. A library link
opens the listener's tracks, with access to the full catalog from the scope
selector. Changing scope replaces the detail URL in place. Existing entity
links continue to resolve.

On Android, the originating surface stays mounted behind an open detail with no
tab pressed. The detail's Back control returns to that surface and its scroll
position, while selecting any tab closes the detail and switches directly to
that tab.

## Enforcement

`npm run design:check` parses JSX and CSS. New raw native controls outside the
primitive allowlist and new literal style debt outside tokens/recipes fail.
The per-file legacy baseline is `ui_web/scripts/design-baseline.json`; removing
debt in one file does not grant another file permission to add it. The gate runs
locally with `npm test` and in CI's `ui_build` job. To reduce the baseline after
a migration, run `node scripts/check-design.mjs --update` and review its diff;
CI never updates it.

`tests/browser/design-system.spec.ts` covers the library's Songs view in dark
and light themes at Compact, Normal and Large on each CI browser profile. Its
reviewed screenshots cover rows, typography, artwork and visible row menus; on
desktop it also measures the shared search field. It checks menu keyboard
anchoring and focus return. These fixture views never contact a real engine or
library.

`Field`, `Select` and `Tabs` were removed with the player's music browser, their
only user. Settings keep their own `SelectRow`.
