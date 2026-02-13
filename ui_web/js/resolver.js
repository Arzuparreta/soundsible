/**
 * Hybrid Stream Resolver
 */
import { store } from './store.js';

export class Resolver {
    static getTrackUrl(track) {
        const host = store.state.activeHost;
        const port = store.state.config.port;
        const protocol = window.location.protocol;
        
        // Use the current activeHost determined by the ConnectionManager
        const baseUrl = `${protocol}//${host}:${port}`;
        const localStreamUrl = `${baseUrl}/api/static/stream/${track.id}`;
        
        return localStreamUrl;
    }

    static getCoverUrl(track) {
        const host = store.state.activeHost;
        const port = store.state.config.port;
        const protocol = window.location.protocol;
        
        const baseUrl = `${protocol}//${host}:${port}`;
        return `${baseUrl}/api/static/cover/${track.id}`;
    }
}
