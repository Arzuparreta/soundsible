/**
 * In-app preview playback for YouTube items (Discover, search ODST).
 * Audio is client-driven: audio.js fetches the stream URL from the API and plays it directly
 * from the CDN; bytes do not go through our server.
 */
import { store } from './store.js';
import { getApiBase } from './config.js';
import { audioEngine } from './audio.js';
import { makeEpisodeId } from './podcast_model.js';

/**
 * Show Deezer title/artist in the omnibar immediately while YouTube resolution is in flight.
 * @param {{ title?: string, artist?: string, duration?: number, cover?: string }} trackLike
 * @param {string|number} deezerId
 */
export function paintOptimisticDeezerPreview(trackLike, deezerId) {
    if (!trackLike) return;
    const artist =
        typeof trackLike.artist === 'string'
            ? trackLike.artist
            : (trackLike.artist && trackLike.artist.name) || '';
    const syntheticTrack = {
        id: `deezer_resolving_${deezerId}`,
        title: trackLike.title || 'Unknown',
        artist: (artist || '').trim(),
        duration: Math.max(0, Number(trackLike.duration) || 0),
        thumbnail: (typeof trackLike.cover === 'string' && trackLike.cover.trim()) || '',
        source: 'preview-pending',
    };
    store.update({ currentTrack: syntheticTrack, isPlaying: false });
}

/**
 * @param {{ id: string, title?: string, artist?: string, channel?: string, duration?: number, duration_sec?: number, thumbnail?: string, webpage_url?: string }} item
 */
function isYoutubeId(id) {
    return id && typeof id === 'string' && id.length === 11 && !id.startsWith('raw-');
}

/**
 * Stream podcast enclosure via Station signed URL (same-origin).
 * @param {{ enclosure_url: string, title?: string, artist?: string, duration?: number, thumbnail?: string }} item
 */
export async function playPodcastPreview(item) {
    const url = item?.enclosure_url;
    if (!url) return;
    const apiBase = getApiBase(store.state.activeHost);
    let streamToken = null;
    try {
        const r = await fetch(`${apiBase}/api/podcasts/enclosure/peek`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enclosure_url: url })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.stream_token) {
            if (typeof window.showToast === 'function') window.showToast(d.error || 'Preview unavailable');
            return;
        }
        streamToken = d.stream_token;
    } catch (e) {
        if (typeof window.showToast === 'function') window.showToast('Preview unavailable');
        return;
    }
    const syntheticTrack = {
        id: item.episode_id || `pcast_${String(streamToken).slice(0, 28)}`,
        title: item.title || 'Episode',
        artist: item.artist || '',
        album: item.album || '',
        duration: Math.max(0, Number(item.duration) || 0),
        thumbnail: item.thumbnail || '',
        source: 'podcast-preview',
        _streamToken: streamToken,
        enclosure_url: url,
        podcast_feed_id: item.podcast_feed_id || null,
        podcast_episode_guid: item.podcast_episode_guid || null,
        podcast_rss_url: item.podcast_rss_url || null,
    };
    store.update({ currentTrack: syntheticTrack });
    const fid = item.podcast_feed_id != null ? String(item.podcast_feed_id) : '';
    const guid = item.podcast_episode_guid != null ? String(item.podcast_episode_guid) : '';
    const episodeKey =
        fid && guid ? makeEpisodeId(fid, guid) : syntheticTrack.id;
    store.recordPodcastPlay({
        episodeId: episodeKey,
        showTitle: (item.artist || '').trim() || 'Podcast',
        author: '',
        rssUrl: item.podcast_rss_url || ''
    });
    audioEngine.playTrack(syntheticTrack);
}

export function playPreview(item) {
    const effectiveId = item?.video_id ?? item?.id;
    if (!item || !effectiveId) return;
    const durationSec = item.duration_sec ?? item.duration ?? 0;
    const duration = Math.max(0, Number(durationSec) || 0);
    const syntheticTrack = {
        id: effectiveId,
        title: item.title || 'Unknown',
        artist: item.artist || item.channel || '',
        duration,
        thumbnail: item.thumbnail || '',
        source: 'preview',
    };
    if (isYoutubeId(effectiveId)) {
        const ids = store.state.libraryYoutubeIds || [];
        const map = store.state.youtubeToTrackId || {};
        if (ids.includes(effectiveId) && map[effectiveId]) {
            syntheticTrack._libraryTrackId = map[effectiveId];
        }
    }
    store.update({ currentTrack: syntheticTrack });
    audioEngine.playTrack(syntheticTrack);
}
