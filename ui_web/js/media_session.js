/**
 * Browser Media Session bridge for lock screens, Bluetooth controls, and car
 * native players that mirror the phone's Now Playing state.
 */

const ARTWORK_SIZES = ['96x96', '128x128', '192x192', '256x256', '384x384', '512x512'];
const PNG_RE = /\.png(?:$|[?#])/i;

export class MediaSessionBridge {
    constructor({ getAudio, getTrack, getCoverUrl, getFallbackArtwork, actions }) {
        this.getAudio = getAudio;
        this.getTrack = getTrack;
        this.getCoverUrl = getCoverUrl;
        this.getFallbackArtwork = getFallbackArtwork;
        this.actions = actions || {};
        this._lastPositionUpdateMs = 0;
    }

    get supported() {
        return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
    }

    installHandlers() {
        if (!this.supported) return;
        const set = (action, handler) => {
            try {
                navigator.mediaSession.setActionHandler(action, handler || null);
            } catch (_) {
                // Unsupported handlers vary by browser and iOS version.
            }
        };
        set('play', () => this.actions.play?.());
        set('pause', () => this.actions.pause?.());
        set('previoustrack', () => this.actions.previous?.());
        set('nexttrack', () => this.actions.next?.());
        set('seekbackward', (event) => this.actions.seekRelative?.(-(event?.seekOffset ?? 10)));
        set('seekforward', (event) => this.actions.seekRelative?.(event?.seekOffset ?? 10));
        set('seekto', (event) => {
            if (typeof event?.seekTime === 'number') this.actions.seekTo?.(event.seekTime);
        });
    }

    updateTrack(track = this.getTrack?.()) {
        if (!this.supported) return;
        if (!track) {
            try {
                navigator.mediaSession.metadata = null;
                navigator.mediaSession.playbackState = 'none';
            } catch (_) {}
            return;
        }
        const artwork = this._artworkForTrack(track);
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: track.title || 'Soundsible',
                artist: track.artist || '',
                album: track.album || '',
                artwork,
            });
        } catch (_) {
            // Invalid/remote artwork should not break playback.
        }
        this.installHandlers();
        this.updatePlaybackState();
        this.updatePosition(true);
    }

    updatePlaybackState() {
        if (!this.supported) return;
        const audio = this.getAudio?.();
        if (!audio) return;
        try {
            navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
        } catch (_) {}
    }

    updatePosition(force = false) {
        if (!this.supported || typeof navigator.mediaSession.setPositionState !== 'function') return;
        const audio = this.getAudio?.();
        if (!audio) return;
        const now = Date.now();
        if (!force && now - this._lastPositionUpdateMs < 1000) return;
        const duration = Number.isFinite(audio.duration) && audio.duration > 0
            ? audio.duration
            : Number(this.getTrack?.()?.duration || 0);
        if (!Number.isFinite(duration) || duration <= 0) return;
        const position = Number.isFinite(audio.currentTime) ? Math.max(0, Math.min(audio.currentTime, duration)) : 0;
        try {
            navigator.mediaSession.setPositionState({
                duration,
                playbackRate: Number.isFinite(audio.playbackRate) ? audio.playbackRate : 1,
                position,
            });
            this._lastPositionUpdateMs = now;
        } catch (_) {}
    }

    _artworkForTrack(track) {
        const coverUrl = this.getCoverUrl?.(track);
        if (coverUrl) {
            const src = this._absoluteUrl(coverUrl);
            const type = PNG_RE.test(src) ? 'image/png' : 'image/jpeg';
            return ARTWORK_SIZES.map((size) => ({ src, sizes: size, type }));
        }
        return (this.getFallbackArtwork?.() || [
            { src: 'assets/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'assets/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ]).map((item) => ({ ...item, src: this._absoluteUrl(item.src) }));
    }

    _absoluteUrl(src) {
        if (!src || typeof window === 'undefined') return src || '';
        try {
            return new URL(src, window.location.href).href;
        } catch (_) {
            return src;
        }
    }
}
