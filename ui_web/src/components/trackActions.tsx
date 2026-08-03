import type { JSX } from 'solid-js';
import { type MenuAction, type ActionMenuOptions } from './ActionMenu';
import { openContextMenu } from '../lib/contextMenu';
import type { Track } from '../types/music';
import { actions, isDownloadingTrack, isFavouriteTrack, isSavedTrack, state } from '../stores';
import { savedFromTrack } from '../lib/saved';
import { shareTrack } from '../lib/share';
import { confirmDialog } from '../lib/confirm';
import { artistPath } from '../lib/artistRoute';
import { isPodcastTrack } from '../lib/track';
import { t } from '../lib/i18n';
import { api } from '../lib/api';
import { toast } from '../lib/toast';

/**
 * Context for building a track's action menu. Optional callbacks let later
 * phases (playlists, metadata, multi-device) plug their handlers in without
 * this module depending on them — an absent handler simply omits its item.
 */
export interface TrackMenuContext {
  navigate?: (path: string) => void;
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

const sw = (d: string): JSX.Element => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const icons = {
  playNext: () => sw('M5 4v16M9 5l8 7-8 7z'),
  queue: () => sw('M3 6h13M3 12h9M3 18h9M16 14v6M19 17h-6'),
  playlist: () => sw('M3 6h13M3 12h9M3 18h7M17 12v7M21 14l-4-2v7'),
  radio: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M4 12a8 8 0 018-8M4 12a8 8 0 008 8M8 12a4 4 0 014-4" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  ),
  artist: () => sw('M16 19a4 4 0 00-8 0M12 11a3 3 0 100-6 3 3 0 000 6M12 2a10 10 0 100 20 10 10 0 000-20'),
  heart: () => sw('M12 21s-7-4.35-9.5-8.5C.9 9.6 2.2 6 5.5 6 7.6 6 9 7.5 12 10c3-2.5 4.4-4 6.5-4 3.3 0 4.6 3.6 3 6.5C19 16.65 12 21 12 21z'),
  edit: () => sw('M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z'),
  share: () => sw('M4 12v8h16v-8M12 16V3M8 7l4-4 4 4'),
  device: () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  ),
  download: () => sw('M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3'),
  save: () => sw('M12 5v14M5 12h14'),
  unsave: () => sw('M5 12h14'),
  remove: () => sw('M5 12h14'),
  trash: () => sw('M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14'),
  feedback: () => sw('M17 14V4M9 18.5l1-4.5H4.5a2 2 0 01-1.9-2.6l2-6A2 2 0 016.5 4H17v10l-4 7a2 2 0 01-4-2.5z'),
  info: () => sw('M12 17v-6M12 7h.01M12 2a10 10 0 100 20 10 10 0 000-20'),
};

/** Build the action list for a track, given its context. */
export function buildTrackMenu(track: Track, ctx: TrackMenuContext = {}): MenuAction[] {
  const isFav = isFavouriteTrack(track);
  /** Has a file on disk. Not the same question as "is it in the library". */
  const isLibrary = track.source !== 'preview';
  const isSaved = isLibrary || isSavedTrack(track);
  const isPodcast = isPodcastTrack(track);
  // A streamed podcast episode plays via a minted token, not a `previewUrl`, so
  // the generic queue can't re-load it — keep it out of queue/playlist flows.
  // Downloaded episodes are real library files and queue fine.
  const queueable = (!isPodcast || isLibrary) && !ctx.auto;
  const list: MenuAction[] = [];

  if (queueable) {
    list.push({ icon: icons.playNext(), label: t('trackActions.playNext'), onSelect: () => actions.playNext(track) });
    list.push({ icon: icons.queue(), label: t('trackActions.addToQueue'), onSelect: () => actions.enqueue(track) });
  }
  if (ctx.onAddToPlaylist && !isPodcast)
    list.push({ icon: icons.playlist(), label: t('trackActions.addToPlaylist'), onSelect: () => ctx.onAddToPlaylist!(track) });
  if (!isPodcast && !ctx.auto)
    list.push({ icon: icons.radio(), label: t('trackActions.startRadio'), onSelect: () => void actions.startRadio(track) });
  if (ctx.navigate && track.artist && isLibrary && !isPodcast)
    list.push({ icon: icons.artist(), label: t('trackActions.goToArtist'), onSelect: () => ctx.navigate!(artistPath(track.artist, { view: 'library' })) });
  // The heart only makes sense over songs you have: it marks some of them out
  // from the others. The menu offers saving instead until then.
  if (!isPodcast && isSaved)
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
  if (track.source === 'preview' && !track.podcast_episode_guid) {
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
        icon: icons.unsave(),
        label: t('collection.unsave'),
        danger: true,
        onSelect: () => actions.toggleSaved(entry),
      });
    }
  }
  if (ctx.onPlayOnDevice && isLibrary && !ctx.auto)
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
