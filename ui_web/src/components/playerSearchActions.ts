/**
 * What the player's search panel does with what it lists.
 *
 * The panel used to have its own answer to "the listener pressed a song": in a
 * DJ session it put the song in the route, while the same press anywhere else
 * in Soundsible started a new session from it. A press now means what it means
 * everywhere — it goes through the same transport action as a library or
 * search row, so in a DJ session it starts a new session from that song.
 *
 * The one exception is an errand the listener started on purpose: the ＋ between
 * two route songs, "Mix with the session", "Change the session". While one is
 * open the press does that errand, and the panel says so above its results.
 */
import { player } from '../stores/player';
import { catalogContextTrack, playCatalogItem, reportSearchPlay, resolveCatalogTrack } from '../lib/catalogItem';
import { toast } from '../lib/toast';
import { t } from '../lib/i18n';
import type { PanelSong } from '../lib/playerSearchResults';
import type { Track } from '../types/music';

/** An errand the panel was opened for. Without one, the panel just plays. */
export type SearchPanelIntent = 'route' | 'reference' | 'change';

export interface IntentContext {
  intent?: SearchPanelIntent;
  /** The route seam a `route` errand inserts before; absent means the end. */
  beforeQueueId?: string;
  /** The errand is done: the panel hands the listener back to the route. */
  onDone?: () => void;
  /** Whether the errand that asked is still the open one. A catalog row is
   * matched over the network; by the time it answers the listener may have
   * cancelled, or opened a different errand. */
  isCurrent?: () => boolean;
}

/** The verb an errand puts on each row. */
export function intentLabel(intent: SearchPanelIntent): string {
  return t(intent === 'route' ? 'autoMode.dj.routeAction' : intent === 'reference' ? 'musicExplorer.reference' : 'musicExplorer.change');
}

async function resolved(song: PanelSong): Promise<Track | null> {
  if ('track' in song) return song.track;
  try {
    return await resolveCatalogTrack(song.item);
  } catch {
    return null;
  }
}

function runIntent(intent: SearchPanelIntent, track: Track, ctx: IntentContext): void {
  const actions = player().actions;
  if (intent === 'route') void actions.placeAutoTrack(track, ctx.beforeQueueId);
  else if (intent === 'reference') actions.useAutoTrackAsSource(track);
  else void actions.changeAutoSession([track], track.title);
  ctx.onDone?.();
}

/** A press on a song row. */
export async function pickSong(song: PanelSong, ctx: IntentContext = {}, fromSearch = false): Promise<void> {
  const intent = ctx.intent;
  if (!intent) {
    if ('track' in song) {
      player().actions.playTrack(song.track);
      return;
    }
    if (fromSearch) reportSearchPlay(song.item);
    await playCatalogItem(song.item);
    return;
  }
  // A session change has to claim the session before the match returns, so a
  // second change started meanwhile is the one that wins.
  const epoch = intent === 'change' ? player().actions.beginAutoSessionChange() : player().actions.autoSessionToken();
  const track = await resolved(song);
  if (!track) {
    toast.error(t('searchPanel.noResolve'));
    return;
  }
  if (player().actions.autoSessionToken() !== epoch || ctx.isCurrent?.() === false) return;
  runIntent(intent, track, ctx);
}

/** The row's quick button: the queue outside a DJ session, the route inside
 * one. The queue takes a catalog row before it is matched — it keeps its place
 * and is matched when its turn comes; the route plans with the song itself. */
export async function queueSong(song: PanelSong): Promise<void> {
  if ('track' in song) {
    player().actions.enqueue(song.track);
    return;
  }
  if (!player().autoMode.active) {
    const pending = catalogContextTrack(song.item);
    if (pending) player().actions.enqueue(pending);
    else toast.error(t('searchPanel.noResolve'));
    return;
  }
  const epoch = player().actions.autoSessionToken();
  const track = await resolved(song);
  if (!track) toast.error(t('searchPanel.noResolve'));
  else if (player().actions.autoSessionToken() === epoch) player().actions.enqueue(track);
}

/** The quick button's label for the mode the player is in. */
export function queueLabel(): string {
  return t(player().autoMode.active ? 'autoMode.dj.routeAction' : 'trackActions.addToQueue');
}
