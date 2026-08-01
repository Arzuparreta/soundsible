# Auto Mode DJ — product contract and UI rework

Status: **engine live since July 2026; the presentation layer is being reworked.**
This document is the contract for both. The critical audit that produced the
engine work is `AUTO_MODE_AUDIT.md`.

Auto remains Soundsible's autonomous listening environment, but its unit of work
is a DJ route rather than a list of recommendations: song selection and
transition quality are planned together. Radio and Autoplay keep their existing
generated-queue planner and playback behaviour.

---

## 1. What Auto is, and what it must never do

Auto is **a place you choose to go**, not a mode the app drifts into.

- It is reached **only** through the mode pill at the top of the player surface.
  Nothing auto-enters it, nothing outside that pill advertises it, and a listener
  who never opens it must not pay for it — in attention, in chrome, or in bytes.
- It is a **different screen**, with its own composition, materials, type scale
  and entrance. Section 5 lists exactly what carries that distinction.
- It owns only its generated lane. Manual queue entries keep their priority.
- Leaving Auto stops generation. If a transition is already dominated by the
  incoming deck, its audible handoff finishes before normal playback resumes.

## 2. Session contract

- Auto can start while music is playing or from idle. An active music track is
  adopted; from idle, Auto selects a non-podcast library or discovery seed.
- The listener chooses a technical DJ independently from musical direction:
  `adaptive`, `long_blend`, `cuts_drops`, or `open_format`.
- Natural-language direction and quick controls alter energy, familiarity,
  destinations and exclusions. Changes are debounced and coalesced, and replan
  only the uncommitted runway.
- Roughly 45 seconds before a blend, the next track is **committed**: it is
  loaded, cued, and no longer replannable. From that point every instruction
  applies to the track after it, and the surface says so.
- Exact song requests form a cancellable FIFO. The first request starts within
  three tracks; each later request is at most three starts after the preceding
  request. Up to two bridge tracks may be inserted.

## 3. Analysis and route planning

`shared/dj_engine.py` decodes a source through FFmpeg to mono float PCM on
stdout and analyses it in memory with NumPy. It extracts tempo/pulse phase,
phrase boundaries, key/mode, energy, loudness, intro/outro cues and confidence.
Tracks over four minutes are analysed from their head and tail only — that is
where a transition is made — which is several times cheaper than decoding the
whole file and answers the same questions. Only versioned JSON features are
persisted in `<cache>/dj/analysis.sqlite3`; decoded or mixed audio is never
written.

**Analysis never runs inside a request.** Planning is on the interaction path,
so `POST /api/discovery/music/dj-plan` uses what is already measured, queues
what is not on a small background pool, and returns a conservative transition
marked as such. `POST /api/discovery/music/dj-transition` re-plans a single pair
from the cache; the player asks for it shortly before committing a handoff, so
a fade becomes a real blend as soon as the features exist.

`dj-plan` gathers a wider candidate pool through the existing recommendation
providers, applies direction, evaluates transition edges and returns a short
route. An exact request is treated as a route destination rather than a manual
queue insertion. Low-confidence or incompatible pairs use a structural fade or
echo cut instead of forced beatmatching. A cue the planner cannot place is
returned as `null` rather than guessed: the player knows the real duration.

Every returned entry may carry analysis (BPM, key, energy, confidence),
transition (cues, overlap, playback rate, technique, score), and request
identity with ETA when the entry fulfils a listener request.

## 4. Live audio

Soundsible plays through **two symmetric decks**. Whichever deck owns playback
is the one the rest of the app observes; a handoff moves that ownership without
loading anything, so a transition costs no re-buffering and the media element
never has its source re-assigned mid-song. Both decks run through a Web Audio
graph built when Auto Mode is entered — a user gesture, and therefore the only
moment an AudioContext can be relied on to start.

The mixer is a state machine — `idle → armed → prerolling → crossfading` — and
every decision reads a **media** clock rather than wall time. A buffering deck
delays its own transition instead of being mixed out of at the wrong moment, and
a pause freezes the blend exactly where it stood. Gains are equal-power curves
ramped on the audio clock; tempo correction is bounded, pitch-preserving, and
returns to unity over the eight seconds after the blend.

Before any transition is armed the player validates it against what is actually
loaded: the cue must have been planned out of the track that is playing, it is
clamped into the real duration, every track gets a minimum airing, and an
unmeasured pair is only ever faded, never beatmatched. A bad plan degrades to a
plain fade; it cannot cut.

At the dominance point, Now Playing, Media Session, queue index and Auto route
move to the incoming track. Techniques emitted are long blend, bass swap, filter
blend, echo cut, structural fade and safe fade. Seek, explicit navigation and any
hard load cancel a prepared transition, and the mixer reports that cancellation
so session state can never drift from what is audible. “Next” inside Auto brings
the prepared handoff forward as a short blend rather than cutting.

**This layer is correct and out of scope for the rework below.**

---

## 5. UI contract

### 5.1 The governing principle

**Shared engineering, distinct composition.**

Auto and Now Playing share *components and mechanics* — the stage tile, the
track-list panel, the search panel, the panel workspace and its mobile carousel.
They do not share *composition*: different panel sets, different defaults,
different materials, different scale, different entrance.

What makes Auto feel like another place is what is on screen and how it is
lit — not a private navigation grammar. A second grammar would only mean a
listener has to re-learn how to move around inside the same player.

### 5.2 What carries the distinction

These are contract, not decoration. If the rework lands and Auto stops feeling
like a different screen, this is the list that failed:

1. **One door.** The mode pill is the only way in. No auto-entry, no Auto
   affordances elsewhere, and Auto's view is code-split so the listener who never
   opens it never downloads or parses it.
2. **A different set of panels.** Auto is `Booth | Stage | Route`; Now Playing is
   `Browser | Stage | Queue`. Only the middle one is the same thing.
3. **Its own layout memory.** `auto:desktopLayout:v1`, separate from
   `np:desktopLayout:v1`. Arranging one never moves the other.
4. **Its own material and scale.** Auto keeps the immersive veil, the darker
   glass, the breathing cover and the ten-foot type scale — expressed as an Auto
   multiplier over the shared semantic tokens, not as a private token set.
5. **Stage-dominant by default, stage-only on demand.** Auto opens on a
   stage-dominant preset and can collapse to the stage alone with one control.
   Mobile always lands on Stage.
6. **A real entrance.** Entering Auto is a transition: the veil rises, panels
   stagger in, and the cover stays exactly where it was — which is free once both
   modes render the same stage element.

### 5.3 The three panels

**Booth** — the DJ control surface.

- DJ profile with its mixing traits, expanding in place; never a dialog.
- “Tell the DJ…” as the primary action of the whole surface.
- Energy and Crate always visible, with unambiguous selected states.
- An honest promise about when an instruction lands (committed vs. runway).
- Pending requests with ETA and cancellation.
- DJ activity as transient feedback, never a permanent technical slot.
- No dark plate, no decorative gold bar, no BPM hero readout. BPM, key and
  technique belong to the next-mix line.

**Stage** — the same component Now Playing uses: cover, identity, lyrics, seek,
transport, save. Not a copy of it.

**Route** — the track-list panel with DJ annotations: position, cover, title,
artist, transition technique and BPM. The committed track is shown locked; later
entries keep “promote”. The full runway, not three cards.

**Requests** are not a fourth view. They are the existing global search panel
with its primary action switched to “Request from the DJ”, plus the ETA promise.
One search implementation in the application, not two.

### 5.4 Desktop

- Three columns of the shared workspace, with the existing resize, reorder and
  persistence. Auto's default preset is stage-dominant
  (about `booth 0.24 / stage 0.52 / route 0.24`).
- Nothing overlaps: Booth and Route are visible *while* the stage plays, which is
  exactly when they are read. No drawer, no backdrop, no focus trap, no private
  Escape handling.
- The DJ selector heads the Booth instead of floating over the stage, so the
  collision with the title stops existing structurally rather than by reserving
  columns.

### 5.5 Mobile

- The same `scroll-snap` carousel and the same chrome dots as Now Playing, fed
  with Auto's panel list. Swipe left for Booth, right for Route.
- The reason is arithmetic, not taste. At 320×568 the cover takes ~238px and
  leaves ~230px to the safe edge; status, seek and transport already spend
  ~100px. A composer field, profile, Energy, Crate and a next-mix summary need
  ~210px more — ~300px of controls in ~230px of space. A panel of its own fits
  them without shrinking the cover and without going modal.
- Short landscape (a phone in a dashboard mount) stops being a special case:
  no tray eats height, the stage compresses, and the other two panels are one
  swipe away. There is no “sheet becomes a side sheet” variant.

### 5.6 Rest state

- Rest **never changes the layout**: nothing is hidden, nothing moves.
- It only dims, and only while playing with an absent or coarse pointer — a TV
  at night and a dashboard are real cases.
- No functional control leaves its place because of inactivity.

### 5.7 State, and the states that are easy to forget

- A single `panel: 'booth' | 'stage' | 'route'`, owned by the player surface.
  The DJ profile is an inline expander, not an overlay state.
- The current four independent booleans (`djPickerOpen`, `requestOpen`,
  `mobilePanel`, `lyricsOpen`, which can all be true at once) disappear.
- The empty booth (“opening the booth”), a podcast on air, and an empty route
  are first-class states with a designed appearance, not fallbacks.

---

## 6. The rework

### 6.1 Why the presentation layer, and why now

The symptoms — the route leaving the viewport, the DJ selector over the title,
inactivity hiding controls, a BPM readout in the place of the primary action, and
direction controls that simply **do not exist** on mobile — are not composition
mistakes. They are what a second player app inside the player produces.

Auto today is 1005 lines of TSX, 2240 of CSS and 138 private `--auto-*` tokens
re-implementing cover, seek, transport, lyrics, saving, track lists, search and a
whole mobile tray system that Now Playing already has next door. The evidence:

- `AutoMode.tsx:159-175` measures Now Playing's cover slot with
  `getBoundingClientRect()` and pins Auto's cover with `position: fixed` at those
  coordinates — then has to release them on `resize` and `orientationchange`
  (`AutoMode.tsx:251-252`) because the reference stops being reliable.
- `AutoMode.module.css:1807` and `:1820` repeat a magic `190px` to keep cover and
  panel apart.
- `AutoMode.module.css:1896-1899` sets `.booth` and `.upStrip` to `display: none`
  on compact, so the direction controls only exist inside a modal sheet.
- `.stage`'s `min-content` is set by the booth, so on short viewports the route
  row is pushed outside `.root`'s `overflow: hidden`.
- `AutoMode.module.css` is 57 KB, statically imported through `PlayerSurface.tsx`,
  and therefore parsed by every listener — including the ones who never open the
  DJ at all.

Meanwhile the panel workspace already exists and is already accepted: Now Playing
renders `browser | stage | queue` as resizable, reorderable, persisted columns on
desktop (`lib/nowPlayingLayout.ts`) and as a `scroll-snap` carousel on mobile,
whose dots live in the shared chrome (`PlayerSurface.tsx:437-461`) and are
explicitly switched off for Auto.

### 6.2 Phases

**Phase 1 — extraction.** Lift out of `NowPlaying.tsx` and `PlayerSurface.tsx`,
with no visible change: the workspace/carousel container, the Stage tile, the
track-list panel (with annotation slots), and the search panel (with a
configurable primary action). Generalise `nowPlayingLayout.ts` to a panel-set
plus storage key.

**Phase 2 — recompose.** Auto renders `[Booth, Stage, Route]` into that
container, code-split behind the mode pill, and the deletion list in 6.3 is
applied.

**Phase 3 — the booth.** Content redesign per 5.3: primary action, Energy/Crate,
the promise, requests, transient activity.

**Phase 4 — content.** Short, consistent labels across
`ui_web/src/lib/i18n/{es,en,fr,zh}.ts`.

### 6.3 What gets deleted

- `syncMobileCoverAnchor` / `releaseMobileCoverAnchor` and every
  `--auto-mobile-cover-*`.
- `mobileDock`, `mobileSheetHead`, `mobileSheetBackdrop`, `mobileDjProfile`,
  `data-mobile-panel`, `--auto-mobile-sheet-top`.
- `requestPanel` and its private search; `djPicker` as a dialog.
- `upStrip`, `filmstrip`, `nextCard` and their sheet variants.
- Most of the 138 `--auto-*` tokens, replaced by the shared semantic scale plus
  an Auto multiplier.
- Manual `inert` juggling and every `position: fixed` fed by measured
  coordinates.

### 6.4 Untouched

Public APIs, planner types, `state.autoMode`, the semantics of
`promoteInAutoRoute`, the DJ engine, transitions, and queue priorities.

---

## 7. Verification

Browser automation and exported audio comparison are deliberately **not** part of
this workflow; visual acceptance is manual, in the running application.

That is affordable because the geometry bugs stop being assertable regressions
and become **impossible by construction**: panels in grid/flex with
`min-height: 0` and their own scrollers, no `position: fixed`, no measured
coordinates, no magic numbers. A route cannot exist outside the viewport if
nothing positions it absolutely.

The automated suite covers:

- Auto mounts with its three panels and never duplicates the route.
- One active panel at a time; the profile expander closes on panel change.
- Focus survives panel changes and mode changes.
- Composer, direction controls, DJ selector, route promotion, request search and
  cancellation.
- Empty booth, podcast on air, empty route.
- Reduced motion, roles and labels.

Required gates:

```text
./venv/bin/python -m pytest -q
./venv/bin/python -m ruff check shared/dj_engine.py shared/api/routes/discovery.py tests/test_dj_engine.py
cd ui_web && npm run test
cd ui_web && npm run build
git diff --check
```

Close with a single commit containing only this rework.

## 8. Assumptions and risk

- Auto is a distinct environment; that distinction is carried by section 5.2, not
  by a navigation grammar of its own.
- The DJ engine is correct and out of scope.
- Every principal control is reachable without opening a modal.

The risk is that Phase 1 edits `NowPlaying.tsx` and `PlayerSurface.tsx`, which
work today. It is accepted deliberately: the rework deletes considerably more
code than it writes, removes 57 KB of CSS from the path of listeners who never
open the DJ, and eliminates an entire class of geometry bug rather than patching
its instances.
