/**
 * Podcast data layer: normalize RSS episodes to track-shaped objects,
 * resolve downloaded vs preview playback, and curated recommendations.
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

/** Curated podcast recommendations (hardcoded). */
export const PODCAST_RECOMMENDATIONS = [
    {
        id: 'rec_1',
        title: 'The Joe Rogan Experience',
        author: 'Joe Rogan',
        rss_url: 'https://feeds.megaphone.fm/GLT5553116091',
        image_url: 'https://megaphone.imgix.net/podcasts/9c258f5e-7f5a-11ec-a95e-2b6908c72087/image/JRE_logo.jpg?ixlib=rails-4.3.1&max-w=3000&max-h=3000&fit=crop&auto=format,compress',
        description: 'Conversations with comedians, actors, musicians, and thinkers.'
    },
    {
        id: 'rec_2',
        title: 'Lex Fridman Podcast',
        author: 'Lex Fridman',
        rss_url: 'https://lexfridman.com/feed/podcast/',
        image_url: 'https://lexfridman.com/wordpress/wp-content/uploads/powerpress/artwork_3000-3000.png',
        description: 'Conversations about science, technology, and the human condition.'
    },
    {
        id: 'rec_3',
        title: 'The Daily',
        author: 'The New York Times',
        rss_url: 'https://feeds.simplecast.com/54nAGcIl',
        image_url: 'https://image.simplecastcdn.com/images/03d8b469-37fc-4733-8b17-d532ec0ab6c2/2df8b28c-4fe5-4d20-8f69-d3a43f7296b9/the-daily-icon-3000x3000.jpg',
        description: 'The biggest stories of our time, in 20 minutes.'
    },
    {
        id: 'rec_4',
        title: 'Huberman Lab',
        author: 'Andrew Huberman',
        rss_url: 'https://feeds.megaphone.fm/hubermanlab',
        image_url: 'https://megaphone.imgix.net/podcasts/8f240582-7f5a-11ec-813d-b3707e81f090/image/Huberman-Lab-Podcast-Image.jpg?ixlib=rails-4.3.1&max-w=3000&max-h=3000&fit=crop&auto=format,compress',
        description: 'Science-based tools for everyday life.'
    },
    {
        id: 'rec_5',
        title: 'This American Life',
        author: 'This American Life',
        rss_url: 'https://www.thisamericanlife.org/podcast/rss.xml',
        image_url: 'https://www.thisamericanlife.org/sites/all/themes/thisamericanlife/images/logo-square-1400.jpg',
        description: 'The most popular weekly documentary show on American radio.'
    },
    {
        id: 'rec_6',
        title: 'The Tim Ferriss Show',
        author: 'Tim Ferriss',
        rss_url: 'https://rss.art19.com/tim-ferriss-show',
        image_url: 'https://content.production.cdn.art19.com/images/d4/71/9f/8f/d4719f8f-3cdd-4756-a672-1553f6588d44/8d3654985447440586c7437ccfc890242b14f04cb8d9b57f440d40c1f32f88d5a2db48f4e328c27a822d434bf2a64685e7b218b0fce1fae46e53a85858b38e10.jpeg',
        description: 'World-class performers share their routines and tactics.'
    },
];

export function getPodcastSubscriptions() {
    return store.state.podcastSubscriptions || [];
}

export function getDownloadedEpisodes(library) {
    return (library || []).filter((t) => t.media_kind === 'podcast_episode');
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
