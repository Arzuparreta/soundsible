# Player rendering and activity scopes

Step 7 of the [web UI review](../../audits/WEB_UI_REVIEW_HANDOFF.md).

## Changes

- The player browser and manual queue use `CollectionRows`, retaining row slots
  instead of rebuilding subtrees. Local search is bounded and mixed artist/song
  results update through accessors. Header origins are measured by the collection.
- Queue occurrences use their stable IDs. Variable editing rows are measured;
  the edited occurrence is pinned and focus survives scrolling and reordering.
- Both panel boxes have `contain: strict`. Their workspace already supplies
  definite dimensions, so changing row text cannot invalidate the intrinsic
  dimensions of neighbouring player tiles. This is panel containment, in addition
  to the row containment that the earlier prototypes tried.
- `createActivityMemo` retains presentation projections without subscribing to
  domain updates while inactive. Library sorting, filtering, search and indexes
  sleep with the browser; queue projections sleep with the queue. The phone's
  inactive panel and a hidden document are inactive too. On activation they catch
  up once. Mounted DOM, scroll and editing state remain. The initial current
  occurrence costs one row, without projecting the full hidden queue. Transport
  scheduling does not use presentation activity.
- Artwork metadata is reconciled per key and per artwork field. An unchanged
  cover reader no longer reruns when another track changes or a full snapshot
  replaces the collection (A3). Account reset still removes every key and hint.

## Visual evidence

The production fixture, normal density, dark theme, paused geometry. These are
rendering changes; labels, artwork, dimensions and composition stay equivalent.

| View | Before | After |
| --- | --- | --- |
| Desktop | [Before](player-desktop-before.png) | [After](player-desktop-after.png) |
| Phone browser | [Before](player-phone-before.png) | [After](player-phone-after.png) |

[Short scroll recording](player-scroll-after.webm). Recording is a separate run,
not used for performance numbers.

## Reproduction

Use `SURFACES=player-browser,player-queue RATES=1,6 REPEATS=3 TAG=step7 node
perf/bench.mjs` in `ui_web`. The queue case creates 300 requests through the
real menu before tracing. The fixtures never access a running engine. Raw
exploratory traces are under `/tmp/soundsible-step7-traces-before` and
`/tmp/soundsible-step7-traces-after` on the measurement host, not in Git.

Final repeated measurements and browser validation are pending while this
implementation is being completed; the audit status remains open until then.
