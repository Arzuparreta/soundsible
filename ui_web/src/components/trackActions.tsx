import { type MenuAction, type ActionMenuOptions } from './ActionMenu';
import { openContextMenu } from '../lib/contextMenu';
import type { Track } from '../types/music';
import { actions, isDownloadingTrack, isFavouriteTrack, isSavedTrack, state } from '../stores';
import { savedFromTrack } from '../lib/saved';
import { shareTrack } from '../lib/share';
import { confirmDialog } from '../lib/confirm';
import { artistDestination, albumDestination, navigateMusic, performerNames, trackMusic, type MusicMetadata } from '../lib/musicNavigation';
import { isPodcastTrack } from '../lib/track';
import { t } from '../lib/i18n';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { menuIcons as icons } from './icons';

/**
 * Context for building a track's action menu. Optional callbacks let later
 * phases (playlists, metadata, multi-device) plug their handlers in without
 * this module depending on them — an absent handler simply omits its item.
 */
export interface TrackMenuContext {
  navigate?: (path: string) => void;
  music?: MusicMetadata;
  collection?: boolean;
  /** Present when the row lives inside a playlist; enables "remove from playlist". */
  playlistName?: string;
  onAddToPlaylist?: (track: Track) => void;
  onRemoveFromPlaylist?: (track: Track) => void;
  /** Opens the metadata editor, which also owns cover art. */
  onEditMetadata?: (track: Track) => void;
  onPlayOnDevice?: (track: Track) => void;
  /** Inside a DJ session. There is no manual queue to add to, no station to
   * start, and no second device to hand the set to — offering any of them is
   * offering to break the thing the listener is currently running. */
  auto?: boolean;
}

/** The links a menu offers into the music itself: one entry per performer, then
 * the record it belongs to. Shared, so a saved row that never resolved to a
 * track offers the same wording and the same icons as the track menu beside it
 * — including the bare "Go to artist" a single performer reads better as. */
export function musicLinkActions(music: MusicMetadata): MenuAction[] {
  if (music.linkable === false) return [];
  const performers = performerNames(music);
  const list: MenuAction[] = performers.map((name) => ({
    icon: icons.artist(),
    label: performers.length > 1 ? `${t('trackActions.goToArtist')}: ${name}` : t('trackActions.goToArtist'),
    onSelect: () => navigateMusic(artistDestination(music, name)),
  }));
  if (music.album?.trim())
    list.push({ icon: icons.album(), label: t('musicExplorer.openAlbum'), onSelect: () => navigateMusic(albumDestination(music)) });
  return list;
}

/** Build the action list for a track, given its context. */
export function buildTrackMenu(track: Track, ctx: TrackMenuContext = {}): MenuAction[] {
  const isFav = isFavouriteTrack(track);
  /** Has a file on disk. Not the same question as "is it in the library". */
  const isLibrary = track.source !== 'preview';
  const isSaved = isLibrary || isSavedTrack(track);
  const isPodcast = isPodcastTrack(track);
  const inAuto = ctx.auto === true || state.autoMode.active;
  // A streamed podcast episode plays via a minted token, not a `previewUrl`, so
  // the generic queue can't re-load it — keep it out of queue/playlist flows.
  // Downloaded episodes are real library files and queue fine.
  const queueable = (!isPodcast || isLibrary) && !inAuto;
  const list: MenuAction[] = [];

  if (inAuto && !isPodcast) {
    list.push({ icon: icons.playNext(), label: t('musicExplorer.playNow'), onSelect: () => actions.playNow(track) });
    list.push({ icon: icons.queue(), label: t('autoMode.dj.routeAction'), onSelect: () => void actions.placeAutoTrack(track) });
    list.push({ icon: icons.source(), label: t('musicExplorer.reference'), onSelect: () => actions.useAutoTrackAsSource(track) });
    list.push({ icon: icons.changeSession(), label: t('musicExplorer.change'), onSelect: () => void actions.changeAutoSession([track], track.title) });
  } else if (queueable) {
    list.push({ icon: icons.playNext(), label: t('trackActions.playNext'), onSelect: () => actions.playNext(track) });
    list.push({ icon: icons.queue(), label: t('trackActions.addToQueue'), onSelect: () => actions.enqueue(track) });
  }
  if (ctx.onAddToPlaylist && !isPodcast)
    list.push({ icon: icons.playlist(), label: t('trackActions.addToPlaylist'), onSelect: () => ctx.onAddToPlaylist!(track) });
  if (!isPodcast)
    list.push({ icon: icons.radio(), label: inAuto ? t('modeChange.startRadio') : t('trackActions.startRadio'), onSelect: () => void actions.startRadio(track) });
  list.push(...musicLinkActions(ctx.music ?? trackMusic(track)));
  // The heart only makes sense over songs you have: it marks some of them out
  // from the others. The menu offers saving instead until then.
  if (ctx.collection !== false && !isPodcast && isSaved)
    list.push({
      icon: icons.heart(),
      label: isFav ? t('trackActions.removeFav') : t('trackActions.addFav'),
      onSelect: () => actions.toggleFavouriteTrack(track),
    });
  if (ctx.onEditMetadata && isLibrary)
    list.push({ icon: icons.edit(), label: t('trackActions.editData'), onSelect: () => ctx.onEditMetadata!(track) });
  list.push({ icon: icons.share(), label: t('trackActions.share'), onSelect: () => void shareTrack(track) });
  if (track.recommendation) {
    if (track.recommendation.reason) {
      list.push({
        icon: icons.info(),
        label: track.recommendation.reason,
        disabled: true,
        onSelect: () => {},
      });
    }
    list.push({
      icon: icons.feedback(),
      label: t('trackActions.notInterested'),
      onSelect: () => void sendNotInterested(track),
    });
  }
  // Having a song and having its bytes are two separate steps, and the menu
  // offers exactly the one the song is standing on.
  // Podcast episodes are excluded — they use a different download flow.
  if (ctx.collection !== false && track.source === 'preview' && !track.podcast_episode_guid) {
    const entry = savedFromTrack(track);
    const alreadyOnDisk = state.library.some((t) => t.youtube_id === track.id || t.id === track.id);
    if (!isSaved) {
      list.push({
        icon: icons.save(),
        label: t('collection.save'),
        onSelect: () => actions.toggleSaved(entry),
      });
    }
    if (!alreadyOnDisk) {
      if (isDownloadingTrack(track)) {
        list.push({ icon: icons.download(), label: t('trackActions.downloading'), disabled: true, onSelect: () => {} });
      } else {
        list.push({
          icon: icons.download(),
          label: t('collection.download'),
          onSelect: () => void actions.downloadSaved(entry),
        });
      }
    }
    if (isSaved) {
      list.push({
        icon: icons.remove(),
        label: t('collection.unsave'),
        danger: true,
        onSelect: () => actions.toggleSaved(entry),
      });
    }
  }
  if (ctx.onPlayOnDevice && isLibrary && !inAuto)
    list.push({ icon: icons.device(), label: t('trackActions.playOnDevice'), onSelect: () => ctx.onPlayOnDevice!(track) });
  if (ctx.playlistName && ctx.onRemoveFromPlaylist)
    list.push({ icon: icons.remove(), label: t('trackActions.removeFromPlaylist'), danger: true, onSelect: () => ctx.onRemoveFromPlaylist!(track) });
  if (isLibrary)
    list.push({ icon: icons.trash(), label: t('trackActions.deleteFromLibrary'), danger: true, onSelect: () => void confirmDelete(track) });

  return list;
}

async function sendNotInterested(track: Track): Promise<void> {
  try {
    const result = await api.sendDiscoveryFeedback({
      media_type: isPodcastTrack(track) ? 'podcast_episode' : 'music_track',
      track_id: track.source === 'preview' ? undefined : track.id,
      title: track.title,
      artist: track.artist,
      youtube_id: !isPodcastTrack(track)
        ? track.youtube_id || (track.source === 'preview' ? track.id : undefined)
        : undefined,
      podcast_feed_id: track.podcast_feed_id,
      podcast_episode_id: track.podcast_episode_guid,
      podcast_show_title: isPodcastTrack(track) ? track.artist : undefined,
      source: track.recommendation?.source,
    });
    if (!result.recorded || !result.event_id) return;
    toast.action(t('trackActions.feedbackSaved'), t('common.undo'), () => {
      void api.undoDiscoveryFeedback(result.event_id!).catch(() => {});
    });
  } catch {
    toast.error(t('trackActions.feedbackFailed'));
  }
}

async function confirmDelete(track: Track): Promise<void> {
  const ok = await confirmDialog({
    title: t('trackActions.deleteTitle'),
    message: t('trackActions.deleteMsg', { title: track.title }),
    confirmLabel: t('trackActions.deleteConfirm'),
    danger: true,
  });
  if (ok) void actions.deleteTrack(track.id);
}

/** The full menu definition for a track (for `use:ctxMenu`). */
export function trackMenuOptions(track: Track, ctx: TrackMenuContext = {}): ActionMenuOptions {
  return { title: track.title, subtitle: track.artist, actions: buildTrackMenu(track, ctx) };
}

/** Open the action menu for a track. Pass the triggering event to anchor a
 * cursor popover on desktop (otherwise a bottom sheet). */
export function openTrackMenu(track: Track, ctx: TrackMenuContext = {}, ev?: MouseEvent): void {
  openContextMenu(trackMenuOptions(track, ctx), ev);
}
