/**
 * Hybrid Stream Resolver
 */
import { store } from './store.js';

export class Resolver {
    static getTrackUrl(track) {
        const host = store.state.activeHost;
        const port = store.state.config.port;
        const protocol = window.location.protocol;
        const baseUrl = `${protocol}//${host}:${port}`;
        // Preview playback URL is resolved in audio.js via stream-url API; do not use server proxy.
        if (track && track.source === 'preview') {
            return '';
        }
        return `${baseUrl}/api/static/stream/${track.id}`;
    }

    static getCoverUrl(track) {
        if (track && track.source === 'preview' && track.thumbnail) {
            return track.thumbnail;
        }
        const host = store.state.activeHost;
        const port = store.state.config.port;
        const protocol = window.location.protocol;
        const baseUrl = `${protocol}//${host}:${port}`;
        return `${baseUrl}/api/static/cover/${track.id}`;
    }
}
