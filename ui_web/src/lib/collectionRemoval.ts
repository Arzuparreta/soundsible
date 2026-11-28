import { t } from './i18n';
import type { Track } from '../types/music';

export function collectionRemoval(track: Track, keepSaved: boolean) {
  return {
    label: t(keepSaved ? 'trackActions.removeDownload' : 'trackActions.deleteFromLibrary'),
    title: t(keepSaved ? 'trackActions.removeDownload' : 'trackActions.deleteTitle'),
    message: t(keepSaved ? 'trackActions.removeDownloadMsg'
      : track.item_id && !track.podcast_episode_guid ? 'trackActions.deleteSongMsg' : 'trackActions.deleteMsg',
    { title: track.title }),
    confirmLabel: t(keepSaved ? 'trackActions.removeDownload' : 'trackActions.deleteConfirm'),
    danger: !keepSaved,
  };
}
