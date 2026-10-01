# DJ mode

The player has two modes: **NORMAL** for ordinary playback and **DJ** for
automatically mixed sets.

**DJ** is Soundsible's built-in automatic DJ. It does not put a crossfade on
a shuffled queue. It builds an editable musical route, analyses how each pair
can meet, prepares the incoming track on a second deck, and performs the handoff
at a chosen cue point.

DJ mode is currently labelled **beta** in the player. Its core mixing and
route workflow is available now; the label sets the expectation that its
planning and interface are still being refined.

## Start a set

- With nothing playing, press **Start a DJ session** in the bottom player, then
  choose music. The DJ chooses an opening from that selection and starts
  the route there.
- With a track playing, open the player and switch from **NORMAL** to **DJ**.
  The current track becomes the first visible influence in **Session**.
- From any song's menu, **Start DJ from this song** makes that song the
  session's source. It is the next song the DJ mixes into, the way it mixes any
  other, and the music comes from it after that.
- In **Session**, use **Mix with…** to add an influence or **Change…** to
  choose a new direction using the same music browser.

### A source is one piece of music

A song, an album, an artist, a playlist or the favourites is **one source**.
Choosing a collection while DJ is on — its primary button, on its page or in
the music browser — moves the session onto it: the DJ draws the next songs from
it. It never turns the collection into a list of requests. Asking for every song
of a collection is still there, by name (**Add to session**) in the
collection's menu, and those songs travel together: they belong to the session
they were asked for in.

The three parts of the workspace have separate jobs:

| Part | What it controls |
| --- | --- |
| **Session** | The musical material and direction DJ should draw from |
| **Stage / Booth** | What is on air, what comes next, energy, depth, and DJ style |
| **Route** | The actual upcoming order, including your fixed tracks and DJ's generated bridges |

## What the DJ listens for

When a track can be analysed, Soundsible measures its tempo and beat grid, key,
energy, musical sections, intro, and outro. It uses those features both to order
candidates and to choose a transition. Depending on the material and DJ style,
the two-deck engine can perform:

- beatmatched long blends;
- bass swaps and filter blends;
- echo cuts and structural cuts;
- conservative fades when the analysis is missing or a more elaborate mix
  would sound worse.

The engine limits tempo stretching and falls back safely instead of forcing two
incompatible recordings together. Loudness levelling sits inside the same
program path, so a transition does not need a sudden volume jump to feel alive.

### Whole songs, without mixing

**Settings → DJ → Mix between songs** is on by default. Switched off, the DJ
keeps choosing the same music in the same route, but every song plays to the
end of its file and the next starts from its beginning, with no fade, effect or
tempo change between them. **Next** and **Play now** cut straight to their
song, and **Fix mix** is hidden: there are no transitions to rebuild.

The switch is an account preference. It applies from the next song the DJ has
not prepared yet; a mix already prepared still plays.

## Make the set yours

- **Add to session** requests specific songs without changing the musical direction.
- **Mix into session** adds an influence alongside the existing ones.
- **Change session** (and **Start DJ from…**) moves the session onto a new
  source at once. The old sources, the DJ's own picks and bridges, and songs
  that were requested as a whole collection go with the old session; songs you
  requested one at a time stay. The current song continues and the DJ mixes out
  of it when it judges best; an already audible blend finishes. The new route is
  then planned like any refill, retrying on its own while the music plays on.
- The Session block shows the active influences. Remove an influence while
  another remains, or use **Change…** to replace the last one.
- **Place a must-play track.** Add a song to the Route or drop it into a
  particular gap. Soundsible may insert a bridge when that produces a safer
  path to the request.
- **Reorder freely.** Moving tracks changes the route immediately. Joins that no
  longer match their original transition use a plain fade until you press
  **Fix mix**.
- **Repair without losing your choices.** **Fix mix** rebuilds transitions and
  generated bridges around the tracks you placed while keeping those tracks in
  their chosen order and depth.
- **Skip without leaving DJ.** Next asks the DJ for a short handoff to the next
  route item instead of dropping back to ordinary playback. Next always does
  something: a blend that is already audible finishes on the spot, and a next
  song that cannot be blended in yet is started the ordinary way.
- **Keep what the DJ finds.** Every Route row has a visible ⋯ menu (also
  available by right-click or mobile long press). The menu saves the song to your
  library, downloads it, marks it as a favourite or adds it to a playlist
  without moving it in the route, including the song already cued.
- **Choose music from anywhere.** Song and collection menus offer the same
  session actions. **Play now** remains an explicit immediate handoff.
  Choosing a musical influence does not also request that exact song.


DJ keeps explicit requests ahead of generated music. Leaving DJ removes its
generated branches and bridges, but tracks you explicitly placed survive as a
normal manual queue.

The **NORMAL / DJ** badge in the mini-player always shows who owns playback. The
choice is sticky for the current listening session and is included in session
handoff state. Only selecting **NORMAL** explicitly, or accepting the prompt
shown before starting incompatible Podcast or Radio playback, leaves DJ mode.
If another song is selected while a blend is already audible, that blend
finishes and the most recent selection is mixed next.

## DJ, Radio, and Autoplay are different

| Mode | Best for | What you control |
| --- | --- | --- |
| **Autoplay** | A small, invisible continuation after an album or playlist ends | An account preference; no separate workspace |
| **Radio** | Endless music related to one seed | Start or stop the generated stream |
| **DJ** | A continuous set with deliberate transitions | Session influences, route, exact requests, and transitions |

DJ explores the active influences together with the last four automatic songs
that actually started playing in the current direction. A pending recommendation
is not a discovery root. Exact requests and bridges do not become roots just
because they played. **Mix with…** retains this exploration; **Change…** clears
it, without promoting the outgoing song. These discovery roots do not appear as
additional influences in **Session**.

A change of direction takes effect at once: the new influences, a new
exploration revision and the cleared route are committed together, and any
answer still in flight for the old direction is discarded when it lands.

### Every handoff ends somewhere

A transition is prepared on the second deck, and nothing fades until that deck
is actually sounding. When it is not — the stream is still buffering, stalled,
or ended seconds in — the handoff still resolves:

- if the outgoing song plays to its end first, the next song is handed over the
  ordinary way, from the deck that was already holding it, with the same
  start-up supervision and stall recovery as any other track change;
- a next song that cannot play at all is dropped and the one after it follows;
- a next song whose stream stops during an audible blend is given up and the
  outgoing song keeps playing, or, if it already owned the music, is recovered
  like any stalled song.

Recordings longer than twenty minutes — DJ sets, live takes, whole albums in one
file — are not chosen as songs of a route unless a source holds nothing else.

If a provider request fails temporarily, DJ retries with increasing delays. If
no new candidates remain, DJ stops repeating the same search and offers **Retry**.
New influences, exploration roots or exclusions make planning eligible again.
Existing playable route entries continue normally in either case.

Session snapshots preserve exploration separately from repeat history. Older
snapshots keep their queue and requests, but history without reliable direction
provenance is not promoted to exploration.

### Continuity validation

A deterministic regression exercises thirty successive routes with overlapping
recommendation neighbourhoods, plus independent tests for direction changes,
request isolation, interrupted preparation and exhausted-input retry behaviour.
A read-only local replay across 204 library tracks and cached related results
produced 1,090 route extensions with both the repaired selector and the baseline
at `2b5a365`, compared with 972 at `34d95f1`. Four tracks had no initial route in
all three runs. Missing cache entries were treated as empty; no live provider
requests or audio playback were performed. This checks selection continuity,
not audible transition quality or physical-device playback.

## Broadcast the result

Live captures the program bus after both decks, loudness levelling, EQ, filters,
crossfade, and echo. Listeners therefore hear the same DJ set that the DJ
hears, not a separate approximation. See [Live](LIVE.md) for HTTPS and room
setup.

## Privacy and storage

Audio analysis is local. Soundsible stores compact measured features in its DJ
cache, not decoded copies of the audio. Listening history and recommendation
signals remain scoped to the account on your Station.

The detailed queue and route rules are recorded in
[Playback queue contract](PLAYBACK_QUEUE_CONTRACT.md). Implementation and data
flow are described in [Architecture](ARCHITECTURE.md).
