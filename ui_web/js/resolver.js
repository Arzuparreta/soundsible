/**
 * Hybrid Stream Resolver
 */
import { store } from './store.js';
import { getApiBase } from './config.js';

function sameOriginBase() {
    if (typeof window === 'undefined' || !window.location) return '';
    const o = window.location.origin;
    if (o && o !== 'null') return o;
    return '';
}

export class Resolver {
    static getTrackUrl(track) {
        // Note: Preview playback is handled in audio.js via GET /api/preview/stream/<ID> (server proxy).
        if (track && track.source === 'preview') {
            return '';
        }
        if (!track?.id) return '';
        const path = `/api/static/stream/${encodeURIComponent(track.id)}`;
        const origin = sameOriginBase();
        if (origin) return `${origin}${path}`;
        return `${getApiBase(store.state.activeHost)}${path}`;
    }

    static getCoverUrl(track) {
        if (track && track.source === 'preview' && track.thumbnail) {
            return track.thumbnail;
        }
        if (!track?.id) return '';
        const path = `/api/static/cover/${encodeURIComponent(track.id)}`;
        const origin = sameOriginBase();
        if (origin) return `${origin}${path}`;
        return `${getApiBase(store.state.activeHost)}${path}`;
    }
}
