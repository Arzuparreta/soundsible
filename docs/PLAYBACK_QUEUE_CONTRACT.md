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

- **One planner** owns candidate ranking, diversification, exclusions, and final
  order for every generated music lane. The browser sends the intent, seed,
  Auto Mode profile, and session exclusions to
  `POST /api/discovery/music/plan`; it does not assemble provider pools.
- **Autoplay** is an account preference, enabled by default. Near the end of a
  finite music context it prepares a small related tail. It never runs for
  podcasts, Radio, Auto Mode, or while repeat is active. Failure ends playback
  normally.
- **Radio** preserves pending manual requests, places its generated mix behind
  them, resumes the mix afterwards, and replenishes its generated runway until
  the listener stops Radio. Starting a new context or stopping Radio aborts
  in-flight generation.
- **Auto Mode** preserves every pending manual request and owns only the
  generated tail behind it. Familiar, Balanced, and Explore are policies of the
  shared server planner; a profile change atomically replaces only that tail.

Async results carry generation identity and may not attach to a newer playback
session after cancellation.

## Scope

This queue is deliberately client-session state. Account settings such as
Autoplay are persisted by the Station API, but queue occurrences are not synced
between browsers or restored as a server queue.
