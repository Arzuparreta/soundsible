/**
 * A DJ errand: the session asked for music, and the next pick answers it.
 *
 * "＋" between two route songs, "Add", "Mix with…" and "Change…" each need the
 * listener to choose music. The player used to carry a music browser of its
 * own for that. Now the app is where music is found, so an errand simply waits
 * for the next choice made anywhere in it: the next song (or, for mixing and
 * changing, the next album, artist or playlist) the listener plays does the
 * errand instead of playing.
 *
 * It works by wrapping the actions the interface sends to the player
 * (`stores/player`). Every list plays through those, so none of them has to
 * know about errands; the store's own calls, and commands from other devices,
 * do not pass through the wrapper and are never taken for a pick.
 */
import { createSignal } from 'solid-js';
import { toast } from './toast';
import { t } from './i18n';
import { isPodcastTrack } from './track';
import type { PlayerActions } from '../stores/contracts';
import type { ContextTrack } from './playbackQueue';
import type { Track } from '../types/music';

export type DjErrandKind = 'route' | 'reference' | 'change';

export interface DjErrand {
  kind: DjErrandKind;
  /** The route seam a `route` errand places before; absent means the end. */
  beforeQueueId?: string;
}

const [errand, setErrand] = createSignal<DjErrand | null>(null);
let onEnd: ((done: boolean) => void) | undefined;

/** The open errand, if any. */
export const djErrand = errand;

/** A pending catalog pick belongs to the request visible when it was made. */
export function guardDjPick(): () => boolean {
  const current = errand();
  return () => errand() === current;
}

/** Open an errand. `end` runs once it is done or cancelled, whichever comes
 * first; opening another replaces this one, as cancelled. */
export function beginDjErrand(next: DjErrand, end?: (done: boolean) => void): void {
  const previous = onEnd;
  onEnd = end;
  setErrand(next);
  previous?.(false);
}

/** Close the open errand: `done` when a pick answered it. */
export function endDjErrand(done: boolean): void {
  if (!errand()) return;
  const end = onEnd;
  onEnd = undefined;
  setErrand(null);
  end?.(done);
}

function pickSong(actions: PlayerActions, current: DjErrand, track: Track): void {
  if (isPodcastTrack(track) || track.unavailable) return;
  if (current.kind === 'route') void actions.placeAutoTrack(track, current.beforeQueueId);
  else if (current.kind === 'reference') actions.useAutoTrackAsSource(track);
  else void actions.changeAutoSession([track], track.title);
  endDjErrand(true);
}

function pickCollection(actions: PlayerActions, current: DjErrand, tracks: Track[], label: string): void {
  const music = tracks.filter((track) => !isPodcastTrack(track) && !track.unavailable);
  if (!music.length) return;
  // A seam asks for songs, so a whole collection lands there song by song.
  if (current.kind === 'route') void actions.placeAutoTracks(music, current.beforeQueueId);
  else if (current.kind === 'reference') {
    actions.addAutoSource(music, label);
    toast.info(t('autoMode.source.added', { title: label }));
  } else void actions.changeAutoSession(music, label);
  endDjErrand(true);
}

/**
 * `actions`, with playing turned into answering the open errand. Without one
 * it is `actions` itself. Only what plays is intercepted: queueing, pausing,
 * seeking and everything else still do what they say.
 */
export function withDjErrand(actions: PlayerActions): PlayerActions {
  const current = errand();
  if (!current) return actions;
  const song = (track: ContextTrack | undefined) => { if (track) pickSong(actions, current, track); };
  const overrides: Partial<PlayerActions> = {
    playTrack: (track) => song(track),
    playNow: (track) => song(track),
    // A radio is started by the store itself, never picked.
    playFrom: (tracks, index, opts) => (opts?.radio ? actions.playFrom(tracks, index, opts) : song(tracks[index])),
    playShuffled: (tracks, context) => pickCollection(actions, current, tracks, context?.label ?? tracks[0]?.title ?? ''),
    startDjSelection: (tracks, label) => {
      if (tracks.length === 1) song(tracks[0]);
      else pickCollection(actions, current, tracks, label);
      return true;
    },
    startDjFromTrack: async (track) => { song(track); return true; },
    // A catalog collection is matched to videos before it is handed over, and
    // starting from it reserves a new session first. Only a change is one;
    // adding to the route or mixing in keeps the session that is playing.
    beginAutoSessionChange: () => (current.kind === 'change' ? actions.beginAutoSessionChange() : actions.autoSessionToken()),
  };
  return Object.assign(Object.create(actions) as PlayerActions, overrides);
}
