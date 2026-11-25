import type { MenuEvent } from '../lib/menuEvent';
import type { MusicLinkIntent } from '../lib/musicNavigation';
import { actions, isDownloadingKeys, isFavouriteKeys, isSavedKeys, ownedTrackForKeys } from '../stores';
import { player } from '../stores/player';
import { catalogContextTrack, resolveCatalogTrack } from '../lib/catalogItem';
import { guardDjPick } from '../lib/djErrand';
import { savedToTrack, savedVideoId } from '../lib/saved';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { t } from '../lib/i18n';
import { openContextMenu } from '../lib/contextMenu';
import type { CatalogItem, RecommendationContext, SavedEntry, Track } from '../types/music';
import { buildTrackMenu, musicLinkActions, queueActions, sendDiscoveryLessFromArtist, sendDiscoveryNotInterested } from './trackActions';
import { openPlaylistPicker } from './PlaylistPicker';
import type { MenuAction } from './ActionMenu';
import { menuIcons } from './icons';
import { openPlayOnDevice } from './DeviceSheet';
import type { ContextTrack } from '../lib/playbackQueue';

export interface EntryMenuContext {
  item?: CatalogItem;
  track?: Track;
  music?: MusicLinkIntent;
  recommendation?: RecommendationContext;
  onDownload?: () => void;
  onRadio?: () => void;
  onNotInterested?: () => void;
  onUndoNotInterested?: () => void;
  onLessFromArtist?: (artist: string) => void;
  onUndoLessFromArtist?: (artist: string) => void;
  busy?: boolean;
}

function catalogFeedbackPayload(entry: SavedEntry, ctx: EntryMenuContext): Record<string, unknown> {
  const item = ctx.item;
  const extDeezer = item?.external_ids?.deezer_id;
  const keyDeezer = entry.keys.find((key) => key.startsWith('deezer:'))?.slice(7);
  const deezerId = typeof extDeezer === 'string' && extDeezer
    ? extDeezer
    : typeof extDeezer === 'number'
      ? String(extDeezer)
      : keyDeezer;
  const extDeezerArtist = item?.external_ids?.deezer_artist_id;
  const deezerArtistId = typeof extDeezerArtist === 'string' && extDeezerArtist
    ? extDeezerArtist
    : typeof extDeezerArtist === 'number'
      ? String(extDeezerArtist)
      : undefined;
  const extYoutube = item?.external_ids?.youtube_id;
  const youtubeId = typeof extYoutube === 'string' && extYoutube
    ? extYoutube
    : savedVideoId(entry) ?? undefined;
  const extIsrc = item?.external_ids?.isrc;
  const isrc = typeof extIsrc === 'string' && extIsrc ? extIsrc : undefined;
  const extMbid = item?.external_ids?.mbid ?? item?.external_ids?.musicbrainz_id;
  const mbid = typeof extMbid === 'string' && extMbid ? extMbid : undefined;
  return {
    media_type: 'music_track',
    track_id: item?.track_id ?? undefined,
    title: item?.title ?? entry.title,
    artist: item ? (item.artist || item.subtitle || entry.artist) : entry.artist,
    youtube_id: youtubeId,
    deezer_id: deezerId,
    ...(deezerArtistId ? { deezer_artist_id: deezerArtistId } : {}),
    isrc,
    ...(mbid ? { mbid } : {}),
    source: ctx.recommendation?.source,
  };
}

async function startCatalogRadio(entry: SavedEntry, item?: CatalogItem): Promise<void> {
  try {
    let track: Track | null = null;
    if (item) {
      track = await resolveCatalogTrack(item);
    } else if (entry.title && entry.artist) {
      const resolved = await api.resolveCatalogItem({
        artist: entry.artist,
        title: entry.title,
        duration: entry.duration,
      });
      if (resolved.video_id) {
        const base = savedToTrack(entry, new Map());
        if (base) {
          track = {
            ...base,
            id: resolved.video_id,
            item_id: resolved.item_id ?? base.item_id,
            originKeys: [...new Set([...entry.keys, `yt:${resolved.video_id}`])],
          };
        }
      }
    }
    if (!track) {
      toast.error(t('search.noPreview'));
      return;
    }
    await player().actions.startRadio(track);
  } catch {
    toast.error(t('search.noPreview'));
  }
}

/** The song an entry stands for before it has been matched to a video: a
 * placeholder the queue, or another device, matches by title and artist when
 * its turn comes. A catalogue row keys it by the row's id, so the match also
 * resolves the row itself. */
function pendingEntryTrack(entry: SavedEntry, item?: CatalogItem): ContextTrack | null {
  if (item) return catalogContextTrack(item);
  if (!entry.title || !entry.artist) return null;
  const base = savedToTrack(entry, new Map());
  if (!base) return null;
  return {
    ...base,
    pendingResolve: { catalogItemId: entry.keys[0], title: entry.title, artist: entry.artist, duration: entry.duration },
  };
}

/** Collection operations use the original saved keys, including unresolved
 * catalogue identities. Merely opening a sheet never resolves or saves it. */
export function buildEntryMenu(entry: SavedEntry, ctx: EntryMenuContext = {}): MenuAction[] {
  const owned = ownedTrackForKeys(entry.keys);
  const saved = Boolean(owned) || isSavedKeys(entry.keys);
  const downloading = ctx.busy || isDownloadingKeys(entry.keys);
  const baseTrack = owned ?? ctx.track ?? (savedVideoId(entry) ? savedToTrack(entry, new Map()) : null);
  const track = baseTrack
    ? (!baseTrack.recommendation && ctx.recommendation ? { ...baseTrack, recommendation: ctx.recommendation } : baseTrack)
    : null;
  const list: MenuAction[] = [];
  if (saved) list.push({
    icon: menuIcons.heart(),
    label: t(isFavouriteKeys(entry.keys) ? 'trackActions.removeFav' : 'trackActions.addFav'),
    onSelect: () => actions.toggleFavourite(entry),
  });
  else list.push({ icon: menuIcons.save(), label: t('collection.save'), onSelect: () => actions.toggleSaved(entry) });
  if (!owned) list.push({
    icon: menuIcons.download(),
    label: t(downloading ? 'collection.downloading' : 'collection.download'), disabled: downloading,
    onSelect: () => { if (ctx.onDownload) ctx.onDownload(); else void actions.downloadSaved(entry); },
  });
  if (track) list.push(...buildTrackMenu(track, {
    collection: false,
    onAddToPlaylist: openPlaylistPicker,
    music: ctx.music,
    onPlayOnDevice: openPlayOnDevice,
    onNotInterested: ctx.onNotInterested,
    onUndoNotInterested: ctx.onUndoNotInterested,
    onLessFromArtist: ctx.onLessFromArtist,
    onUndoLessFromArtist: ctx.onUndoLessFromArtist,
  }));
  const pending = track ? null : pendingEntryTrack(entry, ctx.item);
  if (pending) {
    // The same queue pair `buildTrackMenu` gives a matched song, and under the
    // same rule: a DJ session places songs itself.
    if (!player().autoMode.active) list.push(...queueActions(pending));
    // What a matched song offers for DJ, matching this one only once chosen.
    const resolve = () => (ctx.item ? resolveCatalogTrack(ctx.item) : Promise.resolve(null));
    if (ctx.item) list.push({
      icon: menuIcons.changeSession(),
      label: t('musicExplorer.startDjFromSong'),
      onSelect: async () => {
        const pickIsCurrent = guardDjPick();
        const track = await resolve().catch(() => null);
        if (!pickIsCurrent()) return;
        if (!track) toast.error(t('searchPanel.noResolve'));
        else if (player().autoMode.active) player().actions.startDjSelection([track], track.title);
        else void player().actions.startDjFromTrack(track);
      },
    });
    list.push({ icon: menuIcons.device(), label: t('trackActions.playOnDevice'), onSelect: () => openPlayOnDevice(pending) });
  }
  if (!track && ctx.music) list.push(...musicLinkActions(ctx.music));
  if (ctx.onRadio) {
    const radio = list.findIndex((action) => action.label === t('trackActions.startRadio') || action.label === t('modeChange.startRadio'));
    const action = { icon: menuIcons.radio(), label: t('trackActions.startRadio'), onSelect: ctx.onRadio };
    if (radio >= 0) list[radio] = action; else list.push(action);
  } else if (!track && entry.title && entry.artist) {
    list.push({
      icon: menuIcons.radio(),
      label: t(player().autoMode?.active ? 'modeChange.startRadio' : 'trackActions.startRadio'),
      onSelect: () => void startCatalogRadio(entry, ctx.item),
    });
  }
  if (!track && ctx.recommendation) {
    if (ctx.recommendation.reason) {
      list.push({
        icon: menuIcons.info(),
        label: ctx.recommendation.reason,
        disabled: true,
        onSelect: () => {},
      });
    }
    list.push({
      icon: menuIcons.feedback(),
      label: t('trackActions.notInterested'),
      onSelect: () => void sendDiscoveryNotInterested(catalogFeedbackPayload(entry, ctx), {
        onDismissed: ctx.onNotInterested,
        onUndone: ctx.onUndoNotInterested,
      }),
    });
    const artist = ctx.item?.raw?.artists?.map((name) => name.trim()).find(Boolean)
      || ctx.music?.artists?.map((name) => name.trim()).find(Boolean)
      || (ctx.item ? (ctx.item.artist || ctx.item.subtitle || entry.artist) : entry.artist)?.trim()
      || '';
    if (artist) {
      list.push({
        icon: menuIcons.feedback(),
        label: t('trackActions.lessFromArtist'),
        onSelect: () => void sendDiscoveryLessFromArtist(
          { ...catalogFeedbackPayload(entry, ctx), artist },
          {
            onDismissed: () => ctx.onLessFromArtist?.(artist),
            onUndone: () => ctx.onUndoLessFromArtist?.(artist),
          },
        ),
      });
    }
  }
  if (saved && !owned) list.push({ icon: menuIcons.remove(), label: t('collection.unsave'), danger: true, onSelect: () => actions.toggleSaved(entry) });
  return list;
}

export function openEntryMenu(entry: SavedEntry, ctx: EntryMenuContext = {}, event?: MenuEvent): void {
  openContextMenu({ title: entry.title, subtitle: entry.artist, actions: buildEntryMenu(entry, ctx) }, event);
}
