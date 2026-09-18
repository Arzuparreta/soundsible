import type { DiscoveryFeedItem } from './api';
import type { CatalogItem } from '../types/music';

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
