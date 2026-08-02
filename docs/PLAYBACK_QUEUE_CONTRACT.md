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
  uses `POST /api/discovery/music/dj-plan`, which adds transition analysis,
  short route search and exact-request deadlines. The browser never assembles
  provider pools.
- **Autoplay** is an account preference, enabled by default. Near the end of a
  finite music context it prepares a small related tail. It never runs for
  podcasts, Radio, Auto Mode, or while repeat is active. Failure ends playback
  normally.
- **Radio** preserves pending manual requests, places its generated mix behind
  them, resumes the mix afterwards, and replenishes its generated runway until
  the listener stops Radio. Starting a new context or stopping Radio aborts
  in-flight generation.
- **Auto Mode** is driven by ephemeral `MusicSet` sources. A source may be a
  track, selection, filtered library view, favourites, playlist, album or
  artist. `inside` is a hard eligibility boundary; `from` makes the set a root
  for related-graph walks. Multiple sources form one set arc; they are not
  quotas and are not round-robin lanes. No account-wide taste profile is
  applied unless the listener explicitly adds such a set.
- Auto may be entered empty. A currently sounding song becomes a visible open
  source; a paused song does not until it is resumed. Playing a different song
  while Auto is active is an immediate pivot, not an exit.
- Only exact tracks may be pinned into the route. Reordering a generated row
  pins that occurrence as a waypoint and replans around it. Removing a row is
  neutral; `more like` reinforces its branch for this session and `less like`
  removes that branch and its generated descendants for this session.
- Leaving Auto discards generated branches and bridges. Pending exact waypoints
  survive as ordinary manual queue entries.
- **The committed handoff** is the one upcoming entry Auto Mode has already
  loaded and cued. It survives every replan, and manual insertions land behind
  it rather than in front of it. DJ, direction and request changes are debounced
  and source or route feedback rewrites only the runway past that point — a session can be steered at any
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
