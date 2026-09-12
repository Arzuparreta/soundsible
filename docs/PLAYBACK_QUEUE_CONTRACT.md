# Playback queue contract

The web player owns one session-local play order made of occurrence-based entries.
The same track may appear more than once; `queueId`, not the track ID, identifies
the occurrence.

## Order

Upcoming playback is always:

1. explicit user requests (`manual`);
2. the finite source the user chose (`context`);
3. generated continuation (`generated`).

`Add to queue` appends to the manual lane (FIFO). `Play next` inserts at its
front (LIFO). Choosing another album, playlist, artist, search result set, or
library view starts the selected track immediately, preserves pending manual
requests, replaces the old context, and cancels stale generators.

Shuffle only changes the remaining context order. Clearing the queue from
NORMAL clears pending manual requests, not the active context or generated
continuation. Reordering cannot cross lane or generator boundaries.

## Generated playback

- **Server planners** own candidate ranking, diversification, exclusions, and
  final order. Autoplay and Radio use `POST /api/discovery/music/plan`. DJ
  uses `POST /api/discovery/music/dj-plan` for source-driven runway changes,
  `POST /api/discovery/music/dj-place` for local placement in an existing route,
  and `POST /api/discovery/music/dj-repair` to re-seam a route the listener has
  rearranged. The browser never assembles provider pools.
- **Autoplay** is an account preference, enabled by default. Near the end of a
  finite music context it prepares a small related tail. It never runs for
  podcasts, Radio, DJ, or while repeat is active. Failure ends playback
  normally.
- **Radio** preserves pending manual requests, places its generated mix behind
  them, resumes the mix afterwards, and replenishes its generated runway until
  the listener stops Radio. Starting a new context or stopping Radio aborts
  in-flight generation.
- **DJ** has two independent, composable facts. A route occurrence will
  sound; a persisted session influence steers generation. The same song may participate
  in both without either fact implying the other. Sources may be tracks,
  selections, filtered views, favourites, playlists, albums or artists.
- DJ may be entered empty. Its first selected music starts playback and becomes
  the initial visible influence; entering over a current track uses that track.
  **Add to session** creates requested occurrences, **Mix into session** adds
  influences, and **Change session** replaces influences and generated runway.
  Requested occurrences retain their IDs and relative order across a change.
- Mode is explicit session state. **Play now** is an immediate mix. Collection
  primary actions request songs; mixing and changing live in the action menu.
  Podcast and Radio requests require confirmation before leaving DJ.
- A song dropped into the route inlet is placed by the DJ among editable gaps;
  a song dropped into a concrete gap is fixed there. Both are real queue
  occurrences, not requests or waypoints. Local placement preserves existing
  occurrence ids and order; any bridge belongs to the placed occurrence.
- Adding or removing a source replans generated runway after the committed
  handoff. User occurrences survive; fixed ones keep their slot. Sources
  accumulate with recency decay and never impose a hard genre or set boundary.
- **Reordering the route never re-plans.** A moved occurrence loses the plan
  entry it can no longer honour, so the seams it disturbed fall back to a plain
  fade. This is the safe reading, not a defect: a listener rearranging their set
  is not asking for the runway to be rewritten underneath them.
- **Repair rebuilds manually edited seams, only on request.** `dj-repair` re-seams the
  route around the songs the listener placed: every user occurrence — including
  a `manual` entry, which is as explicit a request as a dragged one — keeps its
  order *and its depth*, while generated and bridge occurrences between them may
  be replaced, dropped or newly invented. Bridges are the one thing allowed to
  make a route longer; filler never is. A repair answering for a route that has
  since changed is discarded rather than applied, and one that came back missing
  a user occurrence is refused outright.
- Requests with `source_policy: explicit` use active influences as the roots for
  planning and bridge retrieval. `heard` excludes repetitions; `seed` anchors
  the audio transition. Neither silently changes musical direction. Older
  clients without the field retain their previous planning contract.
- A source walk is finite and the client excludes everything it already holds,
  so an influence pool does run out. When it can no longer fill the requested
  route — or leaves a seam with no bridge material — recently heard music is
  walked as a fallback retrieval root, weighted below every influence and
  reported as `degraded`. It never becomes a visible influence and never
  reorders what the listener chose. A session must not go quiet because its
  pool is empty.
- A session change prepares a replacement before committing it. New selections
  invalidate older catalogue work and plans. Failed preparation retains the
  previous direction and route. A moving playback anchor causes replanning.
  Preserved requests receive cues for their actual new neighbours, with safe
  fades until live-pair refinement is available.
- Snapshots persist `sourcePolicy` and the active influences. Legacy snapshots
  without influences use the current track, then the last heard track as fallback.
- Leaving DJ discards generated branches and bridges. User route occurrences
  survive as ordinary manual queue entries.
- **The committed handoff** is the one upcoming entry DJ has already
  loaded and cued. It survives additive replans, and manual insertions land behind
  it rather than in front of it. DJ, direction and request changes are debounced
  and source changes rewrite only the runway past that point — a session can be steered at any
  moment without disturbing the mix that is already prepared.
- DJ's plans are **chained**: an entry's transition records which track
  its cue was planned out of, and a refill continues the route from the tail of
  what survives. A cue whose origin does not match what is playing is never
  performed.

Async results carry generation identity and may not attach to a newer playback
session after cancellation.

## Scope

This queue is deliberately client-session state. Account settings such as
Autoplay are persisted by the Station API, but queue occurrences are not synced
between browsers or restored as a server queue.

A full **Change session** may cancel a prepared, still silent handoff once its
replacement is ready. It never cancels an audible blend or resumes paused audio.
