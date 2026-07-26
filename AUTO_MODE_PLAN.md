# Auto Mode — implemented product contract

Status: **implemented on 2026-07-18**.

Auto Mode is Soundsible's self-driving listening environment. It is launched
from Now Playing, covers the full application viewport, respects the listener's
queue, and keeps preparing music from the same library, related-radio and
node-discovery systems already used elsewhere in the player.

Now Playing remains the control room. Auto Mode is the listening room: larger,
ambient, visibly autonomous and deliberately lower-input.

## Locked product decisions

- Auto Mode is available only while a music track is loaded. Podcasts are out
  of scope because the recommendation engines are music-specific.
- Entry never starts or pauses audio. The current play state is preserved.
- Entry *takes the wheel*: it keeps the current track plus the next two manual
  entries as runway and hands the rest of the queue to the pilot. Without this
  a long album/playlist/radio queue left Auto idling in `following_queue` for
  the whole session — nothing was added and switching profile did nothing.
- After takeover, Auto refills the tail whenever fewer than four tracks remain
  and fills the lookahead to eight.
- Exit stops autonomous refilling but leaves playback and the generated queue
  untouched.
- The experience is an in-app full-viewport overlay. It does not request the
  browser Fullscreen API.
- Mobile and desktop are both first-class compositions.
- External discoveries stream as previews. Nothing is downloaded without the
  listener pressing Save.
- The accepted visual direction is “same DNA, another world”: Soundsible's
  orange accent, Plus Jakarta Sans and dark tokens remain, while scale,
  composition, depth and motion change substantially.

## Autopilot contract

The engine lives in `ui_web/src/lib/autopilot.ts` and is independent from the
view. It consumes two quota buckets fed by the platform's discovery
capabilities:

- **Related** — tracks related to the current song (YouTube related-mix) plus
  the current artist's top tracks (`/api/catalog/artist`).
- **Node** — the assembled node-discovery feed plus the trending music feed
  (`/api/discovery/music/feed`).
- **Local** — the listener's own library and favourites.

Node and related identities are already playable video ids. Catalog rows
(charts, artist top-tracks) carry Deezer metadata only, so `discoveryPools.ts`
resolves a bounded number of them to video ids — bounded concurrency, a
session-lived per-track resolution cache, short-TTL feed caches — and drops the
unresolved and library-owned ones. The node feed is awaited to first paint
(`ensureNodeFeedReady`) so it is not empty on the first plan. Related resolution
is given a 12s ceiling because a library seed with no YouTube identity can chain
catalog-resolve → search → related-mix. Autopilot never calls `startRadio()`:
classic Radio is allowed to replace its queue, while Auto Mode is not.

Profiles define the source mix for each eight-slot batch:

| Profile | Local | Related | Nodes |
| --- | ---: | ---: | ---: |
| Familiar | 4 | 3 | 1 |
| Balanced | 2 | 3 | 3 |
| Explore | 1 | 3 | 4 |

Selection deduplicates downloaded/preview twins, excludes the active queue and
the last 60 session identities, and permits at most two tracks by one artist in
a batch. When discovery candidates exist, the number of local tracks is capped
to the profile's local share so an unlucky source mix can't quietly refill the
whole batch from the library (which made every profile look identical and
library-only). The cap is lifted only when no external candidate exists at all,
so offline playback still degrades gracefully to the library instead of
stalling. Generic filler is not used.

Autopilot records ownership and reason metadata outside `Track`. Changing
profile removes only future Auto-owned entries, preserves the current track and
every manual entry, and then plans again. On exit, ownership is forgotten so a
later session treats the surviving queue as the listener's queue.

Shuffle and repeat are temporarily disabled because Auto presents an ordered
plan. Their previous values are restored on exit. An active classic Radio is
adopted without truncation and its Radio flags are cleared.

Network/source exhaustion enters a degraded state and retries after 15, 30 and
60 seconds. Audio errors while Auto is active skip the broken track and trigger
another plan. Skip penalties remain session-local; the backend's positive-only
learning contract is unchanged.

## Environment contract

`AutoMode.tsx` is mounted through a portal so the app underneath can recede,
blur and darken without transforming the Auto surface itself.

The visible hierarchy is intentionally sparse:

- AUTO mark, one cycling profile control and an icon-only exit.
- Current cover, title and artist.
- Ordered transport and the actual upcoming queue.
- Favourite for local tracks; Save for external previews.

Engine work appears only while it is happening, as a transient agent-style
status beside the current track. The working message names the seed being
analysed. Its completion message names the tracks added and reports the real
candidate counts returned by related discovery, nodes and the local library.
There is no persistent activity panel, phase copy or decorative history.

The queue is a native horizontal rail rather than a fixed summary: every future
entry is present, the next card peeks into view, trackpad/touch/mouse-wheel
scrolling works, keyboard focus is visible, and a subtle scrollbar plus a soft
right edge communicate overflow. Cards contain only artwork, title and artist;
they do not explain their own presence or repeat visible counts.

## Layout contract

The three places this screen actually runs — a desktop window, a phone clamped
to a dashboard, a TV across a room — set two rules that outrank composition
taste.

On mobile, continuity with Now Playing is an additional invariant. Entering Auto
captures the live Now Playing artwork slot and anchors Auto's existing cover to
that exact viewport rectangle. The cover therefore does not jump or resize
during the handoff. Auto's own topbar, profile, metadata, transient activity,
transport and complete horizontal cover queue remain unchanged; they replace
the blurred Now Playing chrome through opacity and blur only. Desktop keeps its
existing layout and receding-room transition.

**Content never changes the layout.** Titles run from 3 to 90 characters and the
autopilot's status line appears and clears every few minutes; neither may move
the artwork. The title lives in a fixed two-line well whose type size comes from
a length tier (`titleFit`), clamped to two lines and ellipsised beyond; the
status line has a reserved slot; the artwork is sized from the space that is
left over, never the reverse. Size containment on the cover stage means it
contributes nothing to intrinsic height, so on a viewport too short for
everything the queue rail is pushed out of frame and the transport is not.

**Landscape and portrait are two compositions, not one scaled.** In landscape
(≥600px wide and wider than 5:4) height is the scarce axis, so artwork and text
sit side by side and the title gets roughly half the screen's width. In portrait
they stack. The 5:4 floor deliberately keeps 1280×1024 and 1400×1050 desktops
out of the phone composition. Compact landscape (≤560px tall — a phone in a car
mount) narrows the art column and drops the queue labels; below 400px tall the
rail goes entirely.

**Sizes are viewport-relative with ten-foot ceilings.** At 1080p the title
reaches 76px, the play control 88px and the artwork ~610px, so a TV renders a
readable-from-the-sofa composition rather than a desktop layout centred in a
large window. Nothing in the chrome is smaller than 11px at any size.

After 12 seconds without input the top chrome and the queue rail fade out,
leaving cover, metadata and backdrop. The transport stays on screen at reduced
opacity and stays interactive: pausing from a car mount has to cost one tap, not
a wake-up tap plus an aim. Only opacity changes, so waking the surface never
reflows it. Pointer, touch, keyboard input or a track change restores full
chrome. A downward swipe over the backdrop exits — a swipe that starts on a
control or inside the queue rail belongs to that control. Escape exits globally;
Space and the existing media-session controls continue to work.

Reduced-motion mode disables backdrop drift, cover breathing, equalizer motion
and dot animation while preserving every state and control.

## Public frontend state

The store exposes:

- `AutoProfile`: `familiar | balanced | explore`.
- `AutoPhase`, `AutoActivity`, `AutoPlanItem`, `AutoModeState`.
- `actions.enterAutoMode()` and `actions.exitAutoMode()`.
- `actions.setAutoProfile(profile)` and `actions.autoSkip()`.

The persisted key is `auto:profile`. Session plan, activity, recency and queue
ownership remain ephemeral. No database migration or backend endpoint is
required.

## Verification

Automated coverage includes source quotas, canonical deduplication, artist caps,
queue preservation, lookahead filling, generated ownership, profile replanning,
preference restoration and podcast rejection.

Required gates:

```text
cd ui_web && npm run test
cd ui_web && npm run build
git diff --check
```

Visual acceptance is manual on mobile and desktop. Browser automation remains
disabled for this repository unless the user explicitly requests it again.
