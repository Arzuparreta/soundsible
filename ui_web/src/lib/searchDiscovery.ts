import type { DiscoveryBrowseItem, DiscoveryBrowseSection, DiscoveryFeedItem, DiscoveryMusicFeed } from './api';
import type { CatalogItem } from '../types/music';
import { t } from './i18n';

export interface DiscoveryTrackShelf {
  id: string;
  title: string;
  titleKey?: string;
  titleParams?: Record<string, string>;
  reason?: string;
  reasonKey?: string;
  reasonParams?: Record<string, string>;
  sectionType?: string;
  items: CatalogItem[];
}

/** Only the opened section can keep a visible selection stable during refresh. */
export function discoveryHasVisible(
  sections: readonly DiscoveryBrowseSection[],
  trackShelves: readonly DiscoveryTrackShelf[],
  expanded?: string,
): boolean {
  if (expanded) {
    return sections.some(section => section.id === expanded && section.items.length > 0)
      || trackShelves.some(shelf => shelf.id === expanded && shelf.items.length > 0);
  }
  return sections.some(section => section.items.length > 0)
    || trackShelves.some(shelf => shelf.items.length > 0);
}

/** Build ordered track shelves from `feed.sections`, falling back to flat `feed.items`. */
export function resolveDiscoveryTrackShelves(
  feed: DiscoveryMusicFeed,
  prioritize: (items: readonly CatalogItem[]) => CatalogItem[],
): DiscoveryTrackShelf[] {
  const catalogItems = (feed.items ?? []).map(discoveryCatalogItem);
  const byId = new Map<string, CatalogItem>();
  for (const item of catalogItems) byId.set(item.id, item);

  const shelves: DiscoveryTrackShelf[] = [];
  for (const section of feed.sections ?? []) {
    const resolved: CatalogItem[] = [];
    const seen = new Set<string>();
    for (const itemId of section.item_ids ?? []) {
      if (seen.has(itemId)) continue;
      const item = byId.get(itemId);
      if (!item) continue;
      seen.add(itemId);
      resolved.push(item);
    }
    if (!resolved.length) continue;
    shelves.push({
      id: section.id,
      title: section.title,
      titleKey: section.title_key,
      titleParams: section.title_params,
      reason: section.reason,
      reasonKey: section.reason_key,
      reasonParams: section.reason_params,
      sectionType: section.section_type,
      items: prioritize(resolved),
    });
  }

  if (shelves.length > 0) return shelves;
  if (!catalogItems.length) return [];
  return [{
    id: 'songs',
    title: '',
    titleKey: 'songs',
    items: prioritize(catalogItems).slice(0, 10),
  }];
}

export function discoveryShelfTitle(shelf: DiscoveryTrackShelf): string {
  switch (shelf.titleKey) {
    case 'more_like':
      if (shelf.titleParams?.artist) return t('searchHome.moreLike', { artist: shelf.titleParams.artist });
      break;
    case 'explore_from':
      if (shelf.titleParams?.title) return t('searchHome.exploreFrom', { title: shelf.titleParams.title });
      break;
    case 'from_playlist':
      if (shelf.titleParams?.playlist) return t('searchHome.fromPlaylist', { playlist: shelf.titleParams.playlist });
      break;
    case 'rediscover':
      return t('searchHome.rediscover');
    case 'made_for_library':
      return t('searchHome.madeForLibrary');
    case 'songs':
      return t('searchHome.songs');
  }
  return shelf.title || t('searchHome.songs');
}

export function discoveryShelfReason(shelf: DiscoveryTrackShelf): string {
  if (shelf.id === 'songs' && shelf.titleKey === 'songs' && !shelf.reason && !shelf.reasonKey) return '';
  switch (shelf.reasonKey) {
    case 'because_listen':
      return t('searchHome.reasonMoreLike', shelf.reasonParams);
    case 'explore_connections':
      return t('searchHome.reasonExploreFrom', shelf.reasonParams);
    case 'rediscover':
      return t('searchHome.reasonRediscover', shelf.reasonParams);
    case 'made_for_library':
      return t('searchHome.reasonMadeForLibrary', shelf.reasonParams);
    case 'from_playlist':
      return t('searchHome.reasonFromPlaylist', shelf.reasonParams);
  }
  switch (shelf.titleKey) {
    case 'more_like':
      return t('searchHome.reasonMoreLike', shelf.titleParams);
    case 'explore_from':
      return t('searchHome.reasonExploreFrom', shelf.titleParams);
    case 'rediscover':
      return t('searchHome.reasonRediscover');
    case 'made_for_library':
      return t('searchHome.reasonMadeForLibrary');
    case 'from_playlist':
      return t('searchHome.reasonFromPlaylist');
  }
  return shelf.reason?.trim() || '';
}

export function discoveryEntityReason(item: DiscoveryBrowseItem, round: boolean): string {
  const reason = item.reason_artist?.trim();
  if (!reason) return '';
  const own = (round ? item.title : item.artist || item.title).trim();
  if (own && own.toLowerCase() === reason.toLowerCase()) return '';
  return t('searchHome.similarTo', { artist: reason });
}

export function discoveryEntitySubtitle(item: DiscoveryBrowseItem, round: boolean): string {
  if (round) return '';
  const recordType = item.record_type?.trim().toLowerCase();
  const typeLabel = recordType === 'single'
    ? t('searchHome.recordTypeSingle')
    : recordType === 'ep'
      ? t('searchHome.recordTypeEp')
      : '';
  return [item.artist?.trim() ?? '', typeLabel].filter(Boolean).join(' · ');
}

/** Preserve playable identities and recommendation feedback across the shared row. */
export function discoveryCatalogItem(item: DiscoveryFeedItem): CatalogItem {
  const video = item.external_ids?.youtube_id;
  const youtube = !item.track_id && typeof video === 'string' && !!video;
  return {
    id: item.id, type: item.track_id ? 'library_track' : 'track',
    source: item.track_id ? 'library' : youtube ? 'youtube' : 'deezer',
    title: item.title, artist: item.artist, subtitle: item.artist,
    album: item.album, cover: item.cover, duration: item.duration,
    track_id: item.track_id, external_ids: item.external_ids,
    action_state: item.action_state,
    raw: {
      ...(youtube ? { id: video, youtube_id: video, title: item.title, artist: item.artist } : {}),
      recommendation: item.recommendation_identity ? {
        identity: item.recommendation_identity, source: 'discover', reason: item.reason,
      } : undefined,
    },
  };
}
