# Cohesive view redesign

Working audit and acceptance record for the view redesign. Baseline: merged
`origin/main` at `60e66f1b`. Reviewers: three GPT 6.1 Sol agents, high effort.
Implementation and design iteration: Claude Opus 5.5, high effort, coordinated
in one task branch and one pull request. This is a UI review, not a change to
music identity, audio transport, recommendation ranking or DJ transitions.

## Coverage and findings

| Area | Baseline findings | Design response |
| --- | --- | --- |
| Desktop sidebar / mobile drawer | All destinations carry similar weight; Library subviews consume much of the rail; parent and child can both announce current page | Compact secondary hierarchy, unambiguous current destination, preserve all routes and tab memory |
| AppBar / TabBar | Established mobile title, menu and configurable bottom navigation | Preserve ownership, settings and keyboard/touch targets |
| Discover / Search | No desktop h1; disconnected search and sections; inconsistent cards; empty filtered results and empty expanded feed sections show blank; one-character query reports no results | Recognizable page header, consistent card/section rhythm, explicit visible-content states |
| Search interactions | YouTube mode has no visible route back; suggestions disappear on Tab; version choice bypasses modal focus/Escape machinery; incomplete tab semantics | Visible mode exit, keyboard reachable suggestions, shared overlay, accessible filter group |
| Artist / Album | Misaligned hero/content; mobile titles truncate; selection only in CSS; Save precedes Play; disambiguation is fragile | Shared entity grammar, full title, accessible mode filter, listening first, robust candidate overlay |
| Local artist / album | Failed membership fetch becomes empty and forces Discover; album count always describes catalog; local cover omitted on remote failure | Distinguish load/error/empty, retain intended library view with retry, mode-aware metadata, effective local artwork |
| Discography / related artists | Small 120px rails without desktop controls; repeated empty sections | Consistent readable cards, accessible exploration of long catalogs, one useful empty state |
| Playlists / PlaylistDetail | Menu can receive focus while invisible; detail omits chosen artwork | Visible focus and coherent entity header retaining manual artwork |
| Library / LibraryHome / Favourites | Mature list layout and filters; saved sections hide initial loading/failure; several dead-end empties | Preserve virtualized rows, order and filters; compact honest states; restrained cohesion |
| Saved entities / album and artist grids | Multiple unrelated card dimensions/radii; menu reserves too much text width | Shared card metrics, readable titles and secondary metadata, separate action target |
| Now Playing / player surface / queues | Mature layout, focus restoration and panel behavior; mode tabs have incomplete keyboard semantics | Preserve geometry, transport and queue semantics; complete mode accessibility |
| Podcasts | Missing desktop h1 and different search rhythm | Page header and toolbar consistent with Discover |
| PodcastShow | Tiny artwork, truncated title, management competes with content; download filter has no announced state; failed unsubscribe navigates anyway | Entity header, readable title, explicit filter state, honest busy/error behavior |
| Downloads | Bespoke h2 header and empty/error presentation; header and narrow column misalign | Shared page header and states, deliberate reading alignment |
| Live | Rename only by double-click and unnamed edit input | Visible keyboard/touch edit action and labelled input; retain room and audio identity |
| Settings | Mature desktop split/mobile index, searchable deep links and permissions | Preserve architecture; align shared page vocabulary without decorative rework |
| Login / Invite | Existing labels, autocomplete and password controls are sound | Retain accessible flows and align only where beneficial |
| Import / Migrate | Web file input is display:none and label is not keyboard reachable | Real keyboard-operable file selection, retain analyze-before-import and ambiguity decisions |
| Unknown route | Development overlay demo is used as real 404 | Useful recovery toward Library / Discover |
| Shared Android views | ArtistDiscoveryView and several presentation components are shared with native controllers | Read Android handoff; preserve adapter boundary and verify shared UI without importing web stores |

The source audits distinguish confirmed interaction defects from aesthetic
recommendations. Rendered review uses an isolated HTTP adapter around the
showcase catalog, never a live account or library. Final acceptance is attached
to the final PR head; browser evidence is not physical iOS/Android acceptance.

## Common design contract

- Use existing typography, spacing, ink, radius and control tokens. Album and
  playlist artwork is square with `--radius-md`; artists remain circular.
- Shared browse metrics: `--browse-card-min: 144px`,
  `--browse-card-width: 156px`, `--browse-card-gap: var(--space-lg)`.
  At desktop use 160px minimum, 180px rail width and `--space-xl` gap.
  Put these variables in the shared tokens stylesheet, owned by the navigation
  implementation. Other agents may consume them with fallbacks until present.
- Roots use ViewHeader. The touch shell owns the page title/back, avoiding
  duplicated chrome. Entity headers may show full musical identity and artwork.
- Align entity hero, selector and content to the same gutter. Prefer a compact
  side-by-side mobile hero, a larger desktop composition, full wrapping titles,
  and one content/action toolbar. Primary playback remains direct; secondary
  management stays in the options menu.
- Use grouped `aria-pressed` buttons for search filters and the labelled native
  selector for compact entity content selection. Preserve the complete keyboard
  and panel pattern for real tabs. Active state has geometry as well as color.
  Controls retain usable focus and touch targets at Large interface size.
- Two-line browse titles and stable secondary metadata; clear focus/hover without
  moving cards. Artwork provides identity; avoid extra decorative containers.
- Initial skeleton, retained content during revalidation, compact error + Retry,
  and actionable empty are distinct states. Evaluate the selected content, not
  unrelated sections elsewhere in the response.
- Preserve true MusicLink targets, independent artist-credit links, context and
  long press; opening an entity never plays it. Preserve canonical IDs, queue
  occurrences, selected mode in playback destinations, manual playlist covers,
  saved versus acquired state, scroll restoration and bottom navigation settings.
- Changes to shared presentation must also work in Android's native adapter.
  Do not change web/native audio stores or DJ planning to support visual changes.

## Validation and final review

Implementation and rendered desktop/mobile/light/dark/Large acceptance are
complete. TypeScript and all 1938 unit tests pass. The final stable tree passes
the whole Chromium mobile/desktop suite (414 passed, 74 profile-specific skips)
and WebKit mobile/desktop suite (401 passed, 87 profile-specific skips). WebKit
runs in the pinned Playwright container with a read-only mount and one worker;
the two engines run sequentially against the closed-port fixture backend.

The first Chromium run exposed obsolete direct-bookmark selectors, the intended
sidebar/header snapshot change, and a podcast menu using different desktop
semantics. Collection specs now enter the explicit options menu; the snapshot
was visually inspected and regenerated in the CI image; podcast management uses
the shared focus-managed dialog on both layouts. Affected rechecks and both
complete final suites pass. The new entity geometry suite covers the user's
rejected composition directly, rather than relying on screenshots alone.

Current remote-base verification, final-head GitHub checks and the subsequent
Codex review remain release-review gates for this open PR. Native CI evidence is
separate from browser acceptance; no physical-device acceptance is claimed.

## Independent Claude review: secondary-view simplification

A fresh Claude Opus 5.5 high reviewer examined source, tests and styles without
receiving the implementation audit or design rationale. Verdict: a substantive
improvement over the merged baseline, with one new low-severity focus defect.

| Finding | Disposition |
| --- | --- |
| Live rename failure focuses a still-disabled input | Fixed: input is read-only during submission, with a regression asserting focus after failure |
| Failed podcast unfollow becomes silent after leaving the page | Fixed: global failure notification remains; delayed completion cannot navigate the new page |
| Unused ViewHeader back API and styles | Removed after verifying no call site uses it; route back behavior remains owned by AppBar/entity headers |
| Recovery links repeat button link styling | Moved text-decoration into shared button styling; retained the meaningful Favourites action spacing |
| Duplicate PostCSS readers in new tests | Reused existing stylesheet declaration reader |
| Native Live title copy and limit differ from web/server | Aligned translated default and the server's 96-character limit; native service contract unchanged |
| ViewHeader wrapping CSS assertion could be removed | Retained: small regression check alongside browser geometry acceptance; no new test abstraction |
| Podcast action indentation | Cosmetic; no behavior or extra abstraction required |
| Podcast controls scroll away on desktop | Accepted with the common entity-header pattern; retained keyboard access and explicit refresh |

The reviewer independently validated the measured podcast header margin and
manual activation of NORMAL/DJ tabs; both are retained. This source-only review
does not substitute for the separate rendered UX review or four-profile suite.

## Independent Claude reviews: rendered UX, navigation and collections

Three further fresh Opus 5.5 high reviewers inspected the rendered application
and source without the prior reports. They covered dark/light, desktop,
320/360/390px phones and Normal/Large interface sizes. All judged their scope
clearly improved over the merged baseline. Their tabs were closed afterwards.

| Finding | Disposition |
| --- | --- |
| Podcast unfollow text has insufficient dark contrast | Fixed: secondary ink and a visible resting border |
| Podcast duplicates the entity-header grid and typography | Fixed: uses EntityHero directly; smaller shared phone typography reduces long-title height |
| Downloads empty state names the old Search destination and has no next action | Fixed: translated Discover copy and a real navigation link |
| Unfollow 404 can mean an already-removed subscription | Kept as an error: the endpoint also uses 404 for an unloaded library, so treating every 404 as success would hide a real failure. Error copy now asks to check subscriptions without claiming the show is still followed |
| Discover expansion/return loses keyboard position | Fixed in the shared view: focus the section heading and restore its See all link, without overriding scroll restoration |
| Clearing search loses input focus | Fixed in shared SearchField; external input refs remain supported |
| Three copies of visible-feed logic drift | Replaced with one pure discoveryHasVisible helper used by web, native controller and shared view |
| Touch rails look clipped rather than swipeable | Rails extend to the screen edge, keeping content and focus padding |
| Large desktop sidebar can require scrolling on short screens | Retained accessible scrolling and target sizes; reducing targets to eliminate a scrollbar would harm the selected interface-size behavior |
| Empty searches still offer result filters | Retained stable filter placement during provider work and explicit user-selected filter state; no new network queries |
| Several collection grids collapse to one column at 320px | Fixed in all five consumers with a two-column-aware minimum |
| Title-size heuristic misses real single-word names | Removed the character-count helper; one responsive title rule handles every entity, with wrapping as fallback |
| Artist/album/playlist rows have different gutters | Added a scoped list-padding variable, leaving existing compact player geometry unchanged; nested artist rows compensate section padding |
| Phone entity actions take too many rows | Play stays labelled; Shuffle and bookmark use named icon controls with at least 44px width, retaining control height and state |
| Artist repeats owned count and can leave a dangling separator | Removed duplicate metadata; count remains in the selected collection control |
| Playlist lacks shuffle beside play | Added context-preserving shuffle, hidden in DJ, with a playback-context regression |
| Hero and saved entity derive different artwork | Both now use the same effective artwork accessor |
| Rename Placeholder / change selector accessible names / change See all routing | Optional naming/interaction preferences; retained established routes and semantics |

Integration also measures the podcast header for virtualization instead of
relying on overscan. Regression coverage checks a long heading at Large size,
first/last episode reachability and bounded mounted rows. No audio transport,
DJ planning or persistent navigation preference has been changed.

## User rejection of detail-view composition

The user rejects the current Album/Artist family: the area between artwork/title
and songs still contains three separate rows of controls. The positive prior
review verdicts do not constitute acceptance. Detail design is reopened before
browser suites or PR creation. Two new independent Opus reviews focus on the
composition itself, reducing control rows and prioritizing visible music. Sources
are held stable for that review. Earlier behavior and accessibility fixes remain
part of the task, but the entity-header layout is not considered final.

Both focused Claude reviews then exhausted the provider's five-hour quota before
producing final recommendations. Partial messages and DOM measurements were
recovered. Some viewport changes did not actually apply, so those experimental
figures are not final acceptance evidence. The user explicitly authorized GPT
6.1 Sol high fallback; two new independent Sol reviewers now cover visual
composition and information hierarchy. No PR or rollout is ready at this stage.

## Final detail composition after user feedback

Two independent GPT 6.1 Sol high reviewers completed the quota-interrupted
review. The chosen composition is identity followed by one explicit grid row:
current content, primary command, options. Album and Artist replace the separate
segmented bar with a labelled native selector. The primary command keeps its
complete accessible name and context-specific DJ glyph; its worded label appears
on desktop. Shuffle, bookmark, bulk acquisition and disambiguation remain in the
same options menu. An active collection job marks that menu, announces its
status and opens its existing progress/review/missing detail from there.

The initial Artist tracks heading remains semantic without another visual
control band. Subsequent discography headings remain visible. Playlist has one
count/play/options row and no duplicate top-bar menu. Podcast keeps its episode
filter and an explicit Follow action for new shows; refresh/unfollow move into
options. Its smaller artwork aligns with the top of the full title. Android
entity presentation uses the same pure selector and layout while retaining
native controllers, IDs and offline actions.

A new browser regression suite checks the rejected geometry directly at 360px
Spanish/Large, content switching without a profile refetch or playback, reachable
management actions, full long titles, two-column discography at 320px, and a
visible first episode below a long podcast title. Initial failures exposed a
negative select margin outside the toolbar; it was removed. The playback guard
counts actual track selection/streaming rather than an idle audio-unlock clock
publication with no track or session. Unit/type validation: 234 files, 1938 tests.
Complete final browser profiles pass as recorded above. Final-head GitHub checks
and the subsequent Codex review remain pending before handback.
