export interface PodcastSubscription {
  id: string;
  title: string;
  author?: string;
  rss_url: string;
  image_url?: string | null;
  itunes_collection_id?: string | null;
}

export interface PodcastEpisode {
  guid: string;
  title: string;
  published?: string;
  enclosure_url: string;
  duration_sec?: number;
  image?: string;
}

/** A podcast show from the iTunes directory search. */
export interface PodcastSearchResult {
  title: string;
  author?: string;
  feed_url: string;
  image_url?: string;
  itunes_collection_id?: string;
}
