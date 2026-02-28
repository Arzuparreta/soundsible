/**
 * In-app preview playback for YouTube items (Discover, search ODST).
 * Audio is client-driven: audio.js fetches the stream URL from the API and plays it directly
 * from the CDN; bytes do not go through our server.
 */
import { store } from './store.js';
import { audioEngine } from './audio.js';

/**
 * @param {{ id: string, title?: string, artist?: string, channel?: string, duration?: number, thumbnail?: string, webpage_url?: string }} item
 */
export function playPreview(item) {
    if (!item || !item.id) return;
    const syntheticTrack = {
        id: item.id,
        title: item.title || 'Unknown',
        artist: item.artist || item.channel || '',
        duration: item.duration || 0,
        thumbnail: item.thumbnail || '',
        source: 'preview',
    };
    store.update({ currentTrack: syntheticTrack });
    audioEngine.playTrack(syntheticTrack);
}
