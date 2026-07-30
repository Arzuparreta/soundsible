# Auto Mode DJ — implemented product contract

Status: **live vertical implemented in July 2026**.

Auto remains Soundsible's fullscreen autonomous listening environment, but its
unit of work is now a DJ route rather than a list of recommendations. Song
selection and transition quality are planned together. Radio and Autoplay keep
their existing generated-queue planner and playback behaviour.

## Session contract

- Auto can start while music is playing or from idle. An active music track is
  adopted; from idle, Auto selects a non-podcast library or discovery seed.
- Auto owns only its generated lane. Manual queue entries keep their priority.
- The listener chooses a technical DJ independently from musical direction:
  `adaptive`, `long_blend`, `cuts_drops`, or `open_format`.
- Natural-language direction and quick controls alter energy, familiarity,
  destinations and exclusions. A change replans the uncommitted runway.
- Exact song requests form a cancellable FIFO. The first request starts within
  three tracks; each later request is at most three starts after the preceding
  request. Up to two bridge tracks may be inserted.
- Leaving Auto stops generation. If a transition is already dominated by the
  incoming deck, its audible handoff finishes before normal playback resumes.

## Analysis and route planning

`shared/dj_engine.py` decodes a source through FFmpeg to mono float PCM on
stdout and analyses it in memory with NumPy. It extracts tempo/pulse phase,
phrase boundaries, key/mode, energy, loudness, intro/outro cues and confidence.
Only versioned JSON features are persisted in `<cache>/dj/analysis.sqlite3`;
decoded or mixed audio is never written.

Local files can be analysed immediately. Preview tracks use the existing
full-file preview cache. An uncached preview receives a conservative structural
fallback on its first route and is queued for download/analysis so later plans
use real features.

`POST /api/discovery/music/dj-plan` gathers a wider candidate pool through the
existing recommendation providers, applies direction, evaluates transition
edges and returns a short route. An exact request is treated as a route
destination rather than a manual queue insertion. Low-confidence or
incompatible pairs use a structural fade or echo cut instead of forced
beatmatching.

Every returned entry may carry:

- analysis: BPM, key, energy and confidence;
- transition: outgoing/incoming cues, overlap seconds/bars, playback rate,
  technique and score;
- request identity and ETA when the entry fulfils a listener request.

## Live audio

Normal playback keeps one canonical `HTMLAudioElement`. Auto creates a second
deck and connects both through a lazy Web Audio graph. The incoming deck is
loaded and, where its cue permits, prerolls silently. The engine applies
equal-power gain curves and bounded tempo correction with pitch preservation.

At the dominance point, Now Playing, Media Session, queue index and Auto route
move to the incoming track. At the end of the overlap, the incoming position is
copied back to the canonical element so the rest of Soundsible continues to
observe the same stable media element.

Techniques currently emitted are long blend, bass swap, filter blend, echo cut,
structural fade and safe fade. Seek and explicit navigation cancel a prepared
transition. “Next” inside Auto requests a short version of the prepared DJ
handoff when possible.

## UI

The accepted sparse fullscreen composition remains: cover, identity, transport,
transient engine activity and a horizontal three-track runway. Additions are
action-oriented rather than a technical dashboard:

- functional DJ selector with visible mixing traits;
- natural-language command bar grouped under a plain-language musical direction;
- explicit three-position energy and discovery/familiarity selectors, with the
  current choice always visible;
- request search inside Auto (desktop side panel, full mobile panel);
- request chips with track ETA and cancellation;
- a numbered, human-readable prepared route with translated transition
  techniques and available BPM on runway cards.

The complete DJ control surface consumes Soundsible's semantic typography,
control, segment, pill, row and spacing tokens. Compact, Normal and Large
therefore reflow Auto through the shared interface-size engine; Auto does not
use CSS zoom or a private fixed-size control recipe.

Auto is also reachable from the idle mini-player. Mobile retains the shared
cover handoff with Now Playing, reduced-motion behaviour and dashboard-safe
transport.

## Verification contract

Required gates:

```text
./venv/bin/python -m pytest -q
./venv/bin/python -m ruff check shared/dj_engine.py shared/api/routes/discovery.py tests/test_dj_engine.py
cd ui_web && npm run test
cd ui_web && npm run build
git diff --check
```

Sound acceptance is manual inside the running Soundsible application. Browser
automation and exported audio comparison files are deliberately not part of
the workflow.
