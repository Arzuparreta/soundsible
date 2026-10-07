import type { PodcastSearchResult } from '../types/podcast';

/** A row of `/api/discovery/podcasts/recommendations`, as providers return it. */
export interface RawPodcastRow {
  title?: string;
  author?: string;
  feed_url?: string;
  rss_url?: string;
  image_url?: string;
  itunes_collection_id?: string;
  collectionId?: number | string;
  external_ids?: { rss_url?: string; itunes_collection_id?: string };
  recommendation_identity?: string;
  reason?: string;
  reason_code?: string;
}

/** Recommended shows that can be opened: providers name the feed in three places. */
export function podcastRecommendations(rows: RawPodcastRow[] | undefined): PodcastSearchResult[] {
  return (rows ?? []).map((r) => ({
    title: r.title ?? '',
    author: r.author,
    feed_url: r.feed_url ?? r.rss_url ?? r.external_ids?.rss_url ?? '',
    image_url: r.image_url,
    itunes_collection_id: r.itunes_collection_id ?? r.external_ids?.itunes_collection_id ?? (r.collectionId != null ? String(r.collectionId) : undefined),
    recommendation_identity: r.recommendation_identity,
    reason: r.reason,
    reason_code: r.reason_code,
  })).filter((r) => r.feed_url);
}
