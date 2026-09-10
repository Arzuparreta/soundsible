import type { MusicMetadata } from '../lib/musicNavigation';
import { actions, isDownloadingKeys, isFavouriteKeys, isSavedKeys, ownedTrackForKeys } from '../stores';
import { savedToTrack, savedVideoId } from '../lib/saved';
import { t } from '../lib/i18n';
import { openContextMenu } from '../lib/contextMenu';
import type { SavedEntry, Track } from '../types/music';
import { buildTrackMenu, musicLinkActions } from './trackActions';
import { openPlaylistPicker } from './PlaylistPicker';
import type { MenuAction } from './ActionMenu';

export interface EntryMenuContext {
  track?: Track;
  music?: MusicMetadata;
  onDownload?: () => void;
  onRadio?: () => void;
  busy?: boolean;
}

/** Collection operations use the original saved keys, including unresolved
 * catalogue identities. Merely opening a sheet never resolves or saves it. */
export function buildEntryMenu(entry: SavedEntry, ctx: EntryMenuContext = {}): MenuAction[] {
  const owned = ownedTrackForKeys(entry.keys);
  const saved = Boolean(owned) || isSavedKeys(entry.keys);
  const downloading = ctx.busy || isDownloadingKeys(entry.keys);
  const track = owned ?? ctx.track ?? (savedVideoId(entry) ? savedToTrack(entry, new Map()) : null);
  const list: MenuAction[] = [];
  if (saved) list.push({
    label: t(isFavouriteKeys(entry.keys) ? 'trackActions.removeFav' : 'trackActions.addFav'),
    onSelect: () => actions.toggleFavourite(entry),
  });
  else list.push({ label: t('collection.save'), onSelect: () => actions.toggleSaved(entry) });
  if (!owned) list.push({
    label: t(downloading ? 'collection.downloading' : 'collection.download'), disabled: downloading,
    onSelect: () => { if (ctx.onDownload) ctx.onDownload(); else void actions.downloadSaved(entry); },
  });
  if (track) list.push(...buildTrackMenu(track, { collection: false, onAddToPlaylist: openPlaylistPicker, music: ctx.music }));
  if (!track && ctx.music) list.push(...musicLinkActions(ctx.music));
  if (ctx.onRadio) {
    const radio = list.findIndex((action) => action.label === t('trackActions.startRadio') || action.label === t('modeChange.startRadio'));
    const action = { label: t('trackActions.startRadio'), onSelect: ctx.onRadio };
    if (radio >= 0) list[radio] = action; else list.push(action);
  }
  if (saved && !owned) list.push({ label: t('collection.unsave'), danger: true, onSelect: () => actions.toggleSaved(entry) });
  return list;
}

export function openEntryMenu(entry: SavedEntry, ctx: EntryMenuContext = {}, event?: MouseEvent): void {
  openContextMenu({ title: entry.title, subtitle: entry.artist, actions: buildEntryMenu(entry, ctx) }, event);
}
