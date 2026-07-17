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
- Existing upcoming tracks always play first. Auto adds to the tail only when
  fewer than four tracks remain and fills the lookahead to eight.
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
view. It consumes three candidate pools:

1. Local library and favourites.
2. Tracks related to the current song.
3. The assembled node-discovery feed.

The search/catalog infrastructure is used to resolve a local seed without a
YouTube identity. Autopilot never calls `startRadio()`: classic Radio is allowed
to replace its queue, while Auto Mode is not.

Profiles define the source mix for each eight-slot batch:

| Profile | Local | Related | Nodes |
| --- | ---: | ---: | ---: |
| Familiar | 4 | 3 | 1 |
| Balanced | 2 | 3 | 3 |
| Explore | 1 | 3 | 4 |

Selection deduplicates downloaded/preview twins, excludes the active queue and
the last 60 session identities, and permits at most two tracks by one artist in
a batch. If a source is unavailable, the other real sources fill its slots.
Charts and generic filler are not used.

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
scrolling works, keyboard focus is visible, and a subtle scrollbar communicates
overflow. Cards contain only artwork, title and artist; they do not explain
their own presence or repeat visible counts.

Desktop uses a spacious asymmetric cover/meta stage. Mobile uses the same
information hierarchy in a portrait composition. Neither is a reduced
fallback.

After 12 seconds without input, navigation and queue chrome fade out,
leaving the cover, metadata and ambient backdrop. Pointer, touch, keyboard input
or a track change restores them. A downward swipe exits. Escape exits globally;
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
