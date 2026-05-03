/**
 * Podcast data layer: normalize RSS episodes to track-shaped objects,
 * resolve downloaded vs preview playback.
 */
import { store } from './store.js';
import { getApiBase } from './config.js';
import { Resolver } from './resolver.js';

function safeIdPart(str) {
    return String(str || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
}

export function makeEpisodeId(feedId, guid) {
    return `pcast_${safeIdPart(feedId)}_${safeIdPart(guid)}`;
}

/** Normalize an RSS episode + subscription into a first-class track-like object. */
export function normalizeEpisode(episode, subscription) {
    const feedId = subscription.id || '';
    const guid = episode.guid || episode.enclosure_url || '';
    const libTrack = findLibraryEpisode(feedId, guid, store.state.library);
    return {
        // Library track fields if downloaded (spread first so explicit fields take precedence)
        ...(libTrack ? libTrack : {}),
        id: makeEpisodeId(feedId, guid),
        title: episode.title || 'Episode',
        artist: subscription.title || 'Podcast',
        album: subscription.title || 'Podcasts',
        duration: episode.duration_sec || 0,
        thumbnail: episode.image || subscription.image_url || '',
        source: libTrack ? 'library' : 'podcast-preview',
        enclosure_url: episode.enclosure_url || '',
        podcast_feed_id: feedId,
        podcast_episode_guid: guid,
        podcast_rss_url: subscription.rss_url || '',
        media_kind: 'podcast_episode',
        _libraryTrackId: libTrack ? libTrack.id : null,
    };
}

/** Find a downloaded library track matching this episode. */
export function findLibraryEpisode(feedId, guid, library) {
    if (!library || !feedId || !guid) return null;
    for (const t of library) {
        if (
            t.media_kind === 'podcast_episode' &&
            String(t.podcast_feed_id || '') === String(feedId) &&
            String(t.podcast_episode_guid || '') === String(guid)
        ) {
            return t;
        }
    }
    return null;
}

/** Return a playable track object for audioEngine (library track shape or preview shape). */
export function resolveEpisodeForPlayback(normalizedEpisode) {
    const libId = normalizedEpisode._libraryTrackId;
    if (libId) {
        const t = store.state.library.find((tr) => tr.id === libId);
        if (t) return { ...t, source: 'library' };
    }
    return {
        id: normalizedEpisode.id,
        title: normalizedEpisode.title,
        artist: normalizedEpisode.artist,
        album: normalizedEpisode.album,
        duration: normalizedEpisode.duration,
        thumbnail: normalizedEpisode.thumbnail,
        source: 'podcast-preview',
        enclosure_url: normalizedEpisode.enclosure_url,
        podcast_feed_id: normalizedEpisode.podcast_feed_id,
        podcast_episode_guid: normalizedEpisode.podcast_episode_guid,
        podcast_rss_url: normalizedEpisode.podcast_rss_url,
    };
}

export function getPodcastSubscriptions() {
    return store.state.podcastSubscriptions || [];
}

export function getDownloadedEpisodes(library) {
    return (library || []).filter((t) => t.media_kind === 'podcast_episode');
}

/** Episodes for RSS URL without subscribing (browse). subscriptionStub must include id, title, rss_url, etc. */
export async function fetchEpisodesByRssUrl(rssUrl, subscriptionStub) {
    const apiBase = getApiBase(store.state.activeHost);
    try {
        const r = await fetch(
            `${apiBase}/api/podcasts/episodes-by-url?rss_url=${encodeURIComponent(rssUrl)}`
        );
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.error || r.statusText || 'Failed to fetch episodes');
        const rawEpisodes = d?.episodes || [];
        if (!Array.isArray(rawEpisodes)) throw new Error('Invalid episode data from server');
        const episodes = rawEpisodes.map((ep) => normalizeEpisode(ep, subscriptionStub));
        return { episodes, error: null };
    } catch (e) {
        console.error('fetchEpisodesByRssUrl error:', e);
        return { episodes: [], error: e.message || 'Failed to load episodes' };
    }
}

/** Fetch episodes for a feed. Returns { subscription, episodes, error }. */
export async function fetchEpisodesForFeed(feedId) {
    const subs = getPodcastSubscriptions();
    const sub = subs.find((s) => s.id === feedId);
    if (!sub) return { subscription: null, episodes: [], error: 'Subscription not found' };
    const apiBase = getApiBase(store.state.activeHost);
    try {
        const r = await fetch(`${apiBase}/api/podcasts/feeds/${encodeURIComponent(feedId)}/episodes`);
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.error || r.statusText || 'Failed to fetch episodes');
        const rawEpisodes = d?.episodes || [];
        if (!Array.isArray(rawEpisodes)) throw new Error('Invalid episode data from server');
        const episodes = rawEpisodes.map((ep) => normalizeEpisode(ep, sub));
        return { subscription: sub, episodes, error: null };
    } catch (e) {
        console.error('fetchEpisodesForFeed error:', e);
        return { subscription: sub, episodes: [], error: e.message || 'Failed to load episodes' };
    }
}
