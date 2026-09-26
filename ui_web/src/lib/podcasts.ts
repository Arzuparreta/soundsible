import { api } from './api';
import { actions, state } from '../stores';
import type { PodcastSearchResult, PodcastSubscription } from '../types/podcast';

/** Directory rows this session has shown, by feed. A show opened before it is
 * followed has only its feed to go on, and fetching that takes a while: the
 * page heads itself with the name and artwork the row already showed. */
const shown = new Map<string, PodcastSearchResult>();

/**
 * Where a show opens: its own page once it is followed, otherwise a preview of
 * its feed. Every podcast the app lists can be opened, followed or not — the
 * directory used to answer a tap by subscribing, so looking at a show meant
 * following it, and a failed follow meant the tap did nothing at all.
 */
export function podcastPath(show: PodcastSearchResult): string {
  shown.set(show.feed_url, show);
  const followed = state.podcastSubscriptions.find((sub) => sub.rss_url === show.feed_url);
  return followed
    ? `/podcasts/${encodeURIComponent(followed.id)}`
    : `/podcasts/feed?url=${encodeURIComponent(show.feed_url)}`;
}

export function shownPodcast(feedUrl: string): PodcastSearchResult | undefined {
  return shown.get(feedUrl);
}

/** Follow a show and bring the library's list of shows up to date. Throws when
 * the engine could not read the feed. */
export async function followPodcast(show: PodcastSearchResult): Promise<PodcastSubscription | undefined> {
  const { subscription } = await api.subscribePodcast({
    rss_url: show.feed_url,
    title: show.title,
    author: show.author,
    image_url: show.image_url,
    itunes_collection_id: show.itunes_collection_id,
  });
  void api.emitDiscoveryEvent('podcast_subscribed', {
    media_type: 'podcast_show',
    podcast_feed_id: show.feed_url,
    podcast_show_title: show.title,
    podcast_author: show.author,
    itunes_collection_id: show.itunes_collection_id,
    source: 'podcast_directory',
  }).catch(() => {});
  await actions.syncLibrary();
  return subscription;
}
