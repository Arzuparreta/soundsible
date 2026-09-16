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
front (LIFO). Both keep the context. Playing a song from an album, playlist,
artist, favourites or the library plays it from its position there and makes
that collection the context; a collection's Play button starts at its first
song. Playing a single result — search, a recommendation, the explorer's
search — makes that song a context of its own: the rest of the results do not
follow, and the previous context does not resume. Every choice of context
starts the selected track immediately, preserves pending manual requests,
replaces the old context, and cancels stale generators.

Shuffle only changes the remaining context order. Clearing the queue from
NORMAL clears pending manual requests, not the active context or generated
continuation. Reordering cannot cross lane or generator boundaries.

### NORMAL presentation

The queue panel shows the current song and the pending requests as rows, then
the continuation as cards, never as rows: one card for the active context while
it has anything left to play (with repeat-all, while any of it can come round
again), then one card for Autoplay, always present for music outside Radio.
Cards are not reorderable and are not playable entries.

- The context card carries the context's artwork and page
  (`PlaybackContextDescriptor.cover` / `destination`). Opening it navigates to
  that page; a collection with no page of its own is named without offering
  navigation. Sessions from older builds derive the page from the context id,
  label and next song.
- Removing the context card drops the context's remaining occurrences,
  abandons their catalog matches and any staged deck, keeps the current song
  and every request, and ends repeat-all. Autoplay is the next continuation.
- The Autoplay card toggles the existing account preference. Switched off it is
  dimmed, states its state in text, and its switch stays fully operable.
  Disabling it discards future generated occurrences without cutting the
  current one. Radio keeps its generated rows and gets no Autoplay card.

### Catalog references in a context

A catalog collection (Deezer album, artist top tracks) keeps every row in its
place. Only the tapped row is matched before playback; the others become
context occurrences with `pendingResolve` and a placeholder id. The player
matches the next few ahead of the current entry, in order, replacing each
occurrence in place. A selection that reaches an unmatched occurrence first
shows it loading, stops the outgoing song, and loads it once matched. An
occurrence the engine cannot match is removed and playback moves on to the
next one; the current song is never removed from under the listener. A match
answering for an occurrence that has left the queue restores nothing.
Unmatched occurrences travel in published sessions and are matched on play.

## Generated playback

- **Server planners** own candidate ranking, diversification, exclusions, and
  final order. Autoplay and Radio use `POST /api/discovery/music/plan`. DJ
  uses `POST /api/discovery/music/dj-plan` for source-driven runway changes,
  `POST /api/discovery/music/dj-place` for local placement in an existing route,
  and `POST /api/discovery/music/dj-repair` to re-seam a route the listener has
  rearranged. The browser never assembles provider pools.
- **Autoplay** is an account preference, enabled by default. Near the end of a
  finite music context it prepares a small related tail, shown only as its
  card. It never runs for podcasts, Radio, DJ, or while repeat is active.
  Failure ends playback normally.
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
- Requests with `source_policy: explicit` walk active influences and the separate
  `exploration` context on every plan and bridge lookup. `heard` serves repeat
  avoidance; `seed` anchors the transition. Legacy non-explicit clients keep
  their heard-context behaviour.
- Exploration contains at most four automatic songs that started playing in
  the current `directionRevision`. Pending recommendations, exact requests and
  bridges never become roots merely by being queued or heard.
- **Mix with…** retains exploration. **Change…** prepares with empty exploration
  and the next direction revision while existing playback and refills continue.
  It commits influences, revision, exploration and replacement route together,
  invalidating old planner writes. Failures preserve the previous direction.
  A moving playback anchor causes bounded replanning. Audible blends finish;
  preserved requests receive cues for their actual neighbours.
- Empty plans identify `empty_reason` as `temporary_failure` or `exhausted`.
  Temporary failures retry with backoff. Exhaustion and entirely duplicate
  plans stop retrying identical inputs, including automatic runway checks.
  Changed planning inputs or an explicit Retry permit a new attempt.
- Snapshots persist influences, exploration and direction revision. Legacy
  snapshots without influences use the current track, then the last heard track.
  Missing exploration starts empty; unproven historical tracks are not promoted.
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
