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

Shuffle only changes the remaining context order. Clearing the queue from Now
Playing clears pending manual requests, not the active context or generated
continuation. Reordering cannot cross lane or generator boundaries.

## Generated playback

- **Server planners** own candidate ranking, diversification, exclusions, and
  final order. Autoplay and Radio use `POST /api/discovery/music/plan`. Auto
  uses `POST /api/discovery/music/dj-plan` for source-driven runway changes,
  `POST /api/discovery/music/dj-place` for local placement in an existing route,
  and `POST /api/discovery/music/dj-repair` to re-seam a route the listener has
  rearranged. The browser never assembles provider pools.
- **Autoplay** is an account preference, enabled by default. Near the end of a
  finite music context it prepares a small related tail. It never runs for
  podcasts, Radio, Auto Mode, or while repeat is active. Failure ends playback
  normally.
- **Radio** preserves pending manual requests, places its generated mix behind
  them, resumes the mix afterwards, and replenishes its generated runway until
  the listener stops Radio. Starting a new context or stopping Radio aborts
  in-flight generation.
- **Auto Mode** has two independent, composable facts. A route occurrence will
  sound; an ephemeral source steers generation. The same song may participate
  in both without either fact implying the other. Sources may be tracks,
  selections, filtered views, favourites, playlists, albums or artists.
- Auto may be entered empty. Music that actually sounds joins rolling context,
  but never becomes a visible source implicitly. Adding a source never starts
  playback. Playing a different song while Auto is active remains an immediate
  pivot, not an exit.
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
- **Repair is the only rebuild, and only on request.** `dj-repair` re-seams the
  route around the songs the listener placed: every user occurrence — including
  a `manual` entry, which is as explicit a request as a dragged one — keeps its
  order *and its depth*, while generated and bridge occurrences between them may
  be replaced, dropped or newly invented. Bridges are the one thing allowed to
  make a route longer; filler never is. A repair answering for a route that has
  since changed is discarded rather than applied, and one that came back missing
  a user occurrence is refused outright.
- Only explicit sources and tracks that actually sounded may seed one-hop
  related retrieval. Unplayed recommendations never become graph roots.
- Leaving Auto discards generated branches and bridges. User route occurrences
  survive as ordinary manual queue entries.
- **The committed handoff** is the one upcoming entry Auto Mode has already
  loaded and cued. It survives every replan, and manual insertions land behind
  it rather than in front of it. DJ, direction and request changes are debounced
  and source changes rewrite only the runway past that point — a session can be steered at any
  moment without disturbing the mix that is already prepared.
- Auto Mode's plans are **chained**: an entry's transition records which track
  its cue was planned out of, and a refill continues the route from the tail of
  what survives. A cue whose origin does not match what is playing is never
  performed.

Async results carry generation identity and may not attach to a newer playback
session after cancellation.

## Scope

This queue is deliberately client-session state. Account settings such as
Autoplay are persisted by the Station API, but queue occurrences are not synced
between browsers or restored as a server queue.
