# DJ Mode

DJ Mode (called Auto Mode in the internal APIs) is Soundsible's built-in
automatic DJ. It does not put a crossfade on
a shuffled queue. It builds an editable musical route, analyses how each pair
can meet, prepares the incoming track on a second deck, and performs the handoff
at a chosen cue point.

DJ Mode is currently labelled **beta** in the player. Its core mixing and
route workflow is available now; the label sets the expectation that its
planning and interface are still being refined.

## Start a set

- With nothing playing, press **Start a DJ session** in the bottom player, then
  choose a source. The DJ chooses an opening from that collection and starts
  the route there.
- With a track playing, open the player and switch from **NORMAL** to **DJ**.
  The current track becomes the start of the set.
- Use **Sources** to steer the session with a track, artist, album, playlist,
  favourites, or another selection. Sources influence what Auto generates;
  adding one does not abruptly replace what is playing.

The three parts of the workspace have separate jobs:

| Part | What it controls |
| --- | --- |
| **Sources** | The musical material and direction Auto should draw from |
| **Stage / Booth** | What is on air, what comes next, energy, depth, and DJ style |
| **Route** | The actual upcoming order, including your fixed tracks and Auto's generated bridges |

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

## Make the set yours

- **Steer, do not restart.** Add or remove Sources at any time. The handoff
  already loaded on the second deck stays intact; Auto redraws the runway after
  it.
- **Place a must-play track.** Add a song to the Route or drop it into a
  particular gap. Soundsible may insert a bridge when that produces a safer
  path to the request.
- **Reorder freely.** Moving tracks changes the route immediately. Joins that no
  longer match their original transition use a plain fade until you press
  **Fix mix**.
- **Repair without losing your choices.** **Fix mix** rebuilds transitions and
  generated bridges around the tracks you placed while keeping those tracks in
  their chosen order and depth.
- **Skip without leaving Auto.** Next asks the DJ for a short handoff to the next
  route item instead of dropping back to ordinary playback.
- **Choose music from anywhere.** While the **DJ** badge is active, playing an
  individual song means **Mix now** and uses a short musical handoff. Choosing
  an album, artist, playlist, favourites, or another collection means **Use as
  source**. These actions never switch the mode back to Normal.

Auto keeps explicit requests ahead of generated music. Leaving Auto removes its
generated branches and bridges, but tracks you explicitly placed survive as a
normal manual queue.

The **NORMAL / DJ** badge in the mini-player always shows who owns playback. The
choice is sticky for the current listening session and is included in session
handoff state. Only selecting **NORMAL** explicitly, or accepting the prompt
shown before starting incompatible Podcast or Radio playback, leaves DJ Mode.
If another song is selected while a blend is already audible, that blend
finishes and the most recent selection is mixed next.

## Auto, Radio, and Autoplay are different

| Mode | Best for | What you control |
| --- | --- | --- |
| **Autoplay** | A small, invisible continuation after an album or playlist ends | An account preference; no separate workspace |
| **Radio** | Endless music related to one seed | Start or stop the generated stream |
| **Auto Mode** | A continuous set with deliberate transitions | Sources, route, exact requests, energy, depth, DJ style, and repairs |

All three use Soundsible's local listening signals. Auto additionally considers
whether tracks can form a credible transition and performs that transition in
the browser's two-deck audio engine.

## Broadcast the result

Live captures the program bus after both decks, loudness levelling, EQ, filters,
crossfade, and echo. Listeners therefore hear the same Auto Mode set that the DJ
hears, not a separate approximation. See [Live](LIVE.md) for HTTPS and room
setup.

## Privacy and storage

Audio analysis is local. Soundsible stores compact measured features in its DJ
cache, not decoded copies of the audio. Listening history and recommendation
signals remain scoped to the account on your Station.

The detailed queue and route rules are recorded in
[Playback queue contract](PLAYBACK_QUEUE_CONTRACT.md). Implementation and data
flow are described in [Architecture](ARCHITECTURE.md).
