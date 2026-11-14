# Navigation and loading feedback

Pass over the routes of `ui_web/src/main.tsx`, mobile/desktop navigation,
loading components and settings panels. Branch `fix/ui-navigation-feedback`.

## Findings and changes

- Closing the drawer and the selection now complete together when
  `popstate` is received: removing it earlier briefly exposed the previous view before the
  skeleton. Closes without a selection remain immediate. The history
  is kept and a test delays its resolution to cover the regression.
- The routes split into modules used `lazy` without their own fallback. `asyncPage`
  shows the destination and its title while it imports the code, shares in-flight
  imports and keeps only the module, not the page or account data.
  A response for an abandoned page does not mount it again. Import
  and render failures have a retry and leave the shell navigation available.
- Artists mounts a complete local grid. The title and
  skeleton can now be painted before the mount work through two cancelable frames. This is not
  virtualization or a demonstrated reduction of the total mount time.
- Albums queried the server without its own skeleton and turned errors into
  empty collections. It now separates loading, content, empty and failure with retry;
  on refresh it keeps the previous grid with a busy state and loading text.
- The artist/album pages made the local songs depend on the response
  of the external profile. They can now show them without that dependency. When moving between
  entities, the previous profile is not shown while the new one arrives.
- Playlists and the Podcasts home no longer show an empty state before their
  initial load finishes. Downloads distinguishes a pending request, an error and an empty queue.
- Podcast episodes distinguish an error from an empty feed and allow a retry.
- Playback, Downloads configuration and Subsonic access do not offer editable default
  values before reading the configuration. They share `SettingsLoad`.
  Users and lossless upgrades also show initial loading and a recoverable error.
- Skeletons and buttons from the visual system are reused, with messages in the
  four languages. No minimum wait duration is added. The existing skeletons
  respect reduced motion and announce loading to screen readers.

## Dependency and coverage map

| Surface | Data dependency | Feedback |
| --- | --- | --- |
| Mobile menu, sidebar, bottom bar | Client; history when closing the drawer | Close synchronized with the selection; destination with a common fallback if the module is missing |
| Songs, Favorites, playlist detail | Synchronized library store | `TrackList` already had a skeleton; it is kept |
| Library artists | Synchronized catalog; local grid mount | Round skeleton during the first load and before mounting |
| Library albums | Albums API by order/filter/revision | Initial skeleton, busy refresh, failure with retry |
| Artist / album | External profile and local query by ID, independent of each other | Independent local content; discovery skeleton and retry |
| Playlists | Synchronized store | Initial card skeleton |
| Search / discovery | API, nodes and cache | Per-domain skeletons and inert previous results during search already existed; kept |
| Podcasts | Store subscriptions, recommendations and search | Home skeleton added; existing search feedback kept |
| Episodes | Feed API | Existing skeleton and new error with retry |
| Downloads | Queue API, then events | Initial skeleton, recoverable errors, per-download progress kept |
| Live | Community / audio connection | Existing connection, recovery and creation states kept |
| Import | Restoring the job and import process | Existing `StatusCard` and progress kept |
| Local / account settings | Client preferences and session | Shown without waiting for library data |
| Server / Subsonic settings | Configuration API | Skeleton before the real controls, error and retry |
| Users / lossless | Administration / status API | Initial skeleton and recoverable error |
| Devices / pairing | API and pairing process | Existing skeletons and states kept |
| Player, lyrics, menus and collection actions | Store, audio and one-off requests | Existing specific feedback kept; the shell is not blocked by route loading |
| Login / invitation | Session / token validation | Existing startup screen and form states kept |

## Validation and limits

`cd ui_web && npm test`: typecheck and **1,164 tests / 122 files** passed.
`git diff --check` passed. The added regression tests
check navigation with a pending module, leaving and returning to a route,
import retry, frame cancellation, close synchronized with popstate, pending
catalog, album failure, independence of local tracks, entity change,
downloads queue and settings loading.

No local build was run and no real services or data were modified. The review
covers code and DOM/router tests with controlled requests: it is not a
latency measurement on mobile or visual acceptance on a physical device.
For the pending physical acceptance: menu → Artists/Albums, first visit to each
tab with a slow network, going back during a load and retrying after the network recovers.

The grids still mount all the cards after the first feedback;
a very large library may require separate virtualization work.

## CI fixes

- The catalog rebuild counter is limited to the test's SQLite
  file; opening another database does not alter its assertions. The restart simulation
  invalidates only its schema entry. Python suite: 1,567 tests passed,
  coverage 69.65 % (CI threshold: 55 %).
- The settings search waits for the asynchronous panels to leave their skeletons
  before calculating the scroll offset. The lossless panel above the result
  could grow after the scroll and push the row off the screen. Waiting for
  a slow load is not confused with the timeout of a nonexistent anchor.
- DOM and browser regression tests with a lossless response held beyond the
  anchor timeout; search tests in Chromium and WebKit mobile/desktop.
- Browser in a Playwright container: settings search, mobile navigation and
  interface scale, 119 tests passed and 33 skipped by platform, without
  retries, in Chromium and WebKit mobile/desktop.
