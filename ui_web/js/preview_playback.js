/**
 * In-app preview playback for YouTube items (Discover, search ODST).
 * Audio is client-driven: audio.js fetches the stream URL from the API and plays it directly
 * from the CDN; bytes do not go through our server.
 */
import { store } from './store.js';
import { audioEngine } from './audio.js';

/**
 * @param {{ id: string, title?: string, artist?: string, channel?: string, duration?: number, duration_sec?: number, thumbnail?: string, webpage_url?: string }} item
 */
function isYoutubeId(id) {
    return id && typeof id === 'string' && id.length === 11 && !id.startsWith('raw-');
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
