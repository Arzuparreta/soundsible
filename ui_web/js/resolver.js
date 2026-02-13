/**
 * Hybrid Stream Resolver
 */
import { store } from './store.js';

export class Resolver {
    static getTrackUrl(track) {
        const { host, port } = store.state.config;
        const protocol = window.location.protocol;
        
        // Use the current origin if host matches, otherwise build absolute URL
        const baseUrl = `${protocol}//${host}:${port}`;
        const localStreamUrl = `${baseUrl}/api/static/stream/${track.id}`;
        
        return localStreamUrl;
    }

    static getCoverUrl(track) {
        const { host, port } = store.state.config;
        // Placeholder for cover art endpoint if we add one to API
        // For now, use a generic placeholder or the track ID
        return `http://${host}:${port}/api/static/stream/${track.id}`; // This will return audio, not image. 
        // Need to add cover streamer to API or use online fetcher
    }
}
