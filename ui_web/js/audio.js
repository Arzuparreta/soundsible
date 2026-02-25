/**
 * Web Audio Engine - Resilience & Hot-Swap Support
 */
import { store } from './store.js';
import { Resolver } from './resolver.js';
import { connectionManager } from './connection.js';
import { Haptics } from './haptics.js';
import { isVisible } from './visibility.js';

const PRELOAD_THRESHOLD_SEC = 45;
const PUSH_DEBOUNCE_VISIBLE_SEC = 5;
const PUSH_DEBOUNCE_HIDDEN_SEC = 15;

class AudioEngine {
    constructor() {
        this.audio = new Audio();
        this.audio.crossOrigin = 'anonymous';
        this.currentPosition = 0;
        this.currentContext = []; // Sequential fallback
        /** Track ID we already repeated once in repeat(1) mode; cleared when song changes. */
        this._repeatOnceUsedTrackId = null;
        /** Auxiliary audio element for pre-loading next track URL (cache only; never play()). */
        this._preloadAudio = null;
        /** Track ID we last preloaded, to avoid re-preloading every timeupdate. */
        this._preloadedTrackId = null;
        this.init();
    }

    _getPreloadAudio() {
        if (!this._preloadAudio) {
            this._preloadAudio = new Audio();
            this._preloadAudio.crossOrigin = 'anonymous';
            this._preloadAudio.preload = 'auto';
        }
        return this._preloadAudio;
    }

    /** Peek next track (mirror of next() logic, no queue pop). Used for pre-buffering. */
    _getNextTrackForPreload() {
        const currentTrack = store.state.currentTrack;
        const mode = store.state.repeatMode;

        if (mode === 'one' && currentTrack) return currentTrack;

        if (mode === 'once' && currentTrack) {
            if (this._repeatOnceUsedTrackId !== currentTrack.id) return currentTrack;
            // consumed; fall through to queue/context
        }

        const fromQueue = store.peekNextFromQueue();
        if (fromQueue) return fromQueue;

        if (this.currentContext && this.currentContext.length > 0 && currentTrack) {
            const currentIndex = this.currentContext.findIndex(t => t.id === currentTrack.id);
            const shuffleOn = store.state.shuffleEnabled;
            if (currentIndex !== -1 && currentIndex < this.currentContext.length - 1) {
                return shuffleOn
                    ? this._pickRandomFromContext(this.currentContext, currentTrack.id)
                    : this.currentContext[currentIndex + 1];
            }
        }
        return null;
    }

    _preloadTrack(track) {
        if (!track?.id) return;
        const url = Resolver.getTrackUrl(track);
        const el = this._getPreloadAudio();
        el.src = url;
        el.load();
        this._preloadedTrackId = track.id;
    }

    _invalidatePreload() {
        this._preloadedTrackId = null;
        if (this._preloadAudio) this._preloadAudio.src = '';
    }

    setContext(tracks) {
        this.currentContext = tracks;
    }

    /** Pick a random track from context. If excludeId is set, exclude that track (avoids instant replay). */
    _pickRandomFromContext(context, excludeId) {
        const pool = excludeId ? context.filter(t => t.id !== excludeId) : [...context];
        if (pool.length === 0) return null;
        return pool[Math.floor(Math.random() * pool.length)];
    }

    init() {
        if (store.state.muted) {
            this.audio.volume = 0;
        } else {
            const v = store.state.volume;
            this.audio.volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
        }
        this.audio.addEventListener('ended', () => this.next());
        this.audio.addEventListener('timeupdate', () => {
            this.currentPosition = this.audio.currentTime;
            this.onTimeUpdate();
        });
        
        this.audio.addEventListener('play', () => {
            store.update({ isPlaying: true });
            store.pushPlaybackState(store.state.currentTrack?.id, this.audio.currentTime, true);
            Haptics.heavy();
        });
        this.audio.addEventListener('pause', () => {
            store.update({ isPlaying: false });
            store.pushPlaybackState(store.state.currentTrack?.id, this.audio.currentTime, false);
            Haptics.lock();
        });
        
        this.audio.addEventListener('error', (e) => {
            console.error("Playback error:", this.audio.error);
            store.update({ isPlaying: false });
            Haptics.error();
        });

        if ('mediaSession' in navigator) {
            this.setMediaSessionHandlers();
        }

        setInterval(() => {
            if (isVisible() && typeof document !== 'undefined' && document.hasFocus() && store.state.currentTrack) {
                store.pushPlaybackState(store.state.currentTrack.id, this.audio.currentTime, !this.audio.paused);
            }
        }, 20000);

        // Stop when another device resumes (server sends playback_stop_requested)
        if (typeof window !== 'undefined') {
            window.addEventListener('playback_stop_requested', () => this.pause());
        }
    }

    /** Set Media Session action handlers (prev/next work on Android; iOS does not show them). */
    setMediaSessionHandlers() {
        if (!('mediaSession' in navigator)) return;
        navigator.mediaSession.setActionHandler('play', () => this.play());
        navigator.mediaSession.setActionHandler('pause', () => this.pause());
        navigator.mediaSession.setActionHandler('previoustrack', () => this.prev());
        navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
        const skip = (delta) => {
            if (!this.audio.duration) return;
            this.audio.currentTime = Math.max(0, Math.min(this.audio.duration, this.audio.currentTime + delta));
        };
        try {
            navigator.mediaSession.setActionHandler('seekbackward', (e) => skip(-(e?.seekOffset ?? 10)));
            navigator.mediaSession.setActionHandler('seekforward', (e) => skip(e?.seekOffset ?? 10));
        } catch (_) { /* seekbackward/seekforward not supported */ }
    }

    async playTrack(track) {
        // Any song change (different track) resets repeat
        if (store.state.currentTrack && track.id !== store.state.currentTrack.id) {
            store.update({ repeatMode: 'off' });
            this._repeatOnceUsedTrackId = null;
        }

        // Prevent redundant loads if tapping the same track rapidly
        if (this.audio.src.includes(track.id) && !this.audio.paused) {
            console.log("Track already playing, ignoring redundant request.");
            return;
        }

        this._invalidatePreload();

        const url = Resolver.getTrackUrl(track);
        console.log("Playing URL:", url);
        
        try {
            this.audio.src = url;
            this.audio.load();
            await this.audio.play();
            store.update({ currentTrack: track, isPlaying: true });
            store.pushPlaybackState(track.id, 0, true);

            if ('mediaSession' in navigator) {
                const coverUrl = track?.id ? Resolver.getCoverUrl(track) : null;
                const sizes = ['96x96', '128x128', '192x192', '256x256', '384x384', '512x512'];
                const artwork = coverUrl
                    ? [
                        ...sizes.map(size => ({ src: coverUrl, sizes: size, type: 'image/jpeg' })),
                        { src: 'assets/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
                        { src: 'assets/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
                    ]
                    : [
                        { src: 'assets/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
                        { src: 'assets/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
                    ];
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: track.title,
                    artist: track.artist,
                    album: track.album,
                    artwork
                });
                this.setMediaSessionHandlers();
            }
        } catch (err) {
            // SECURITY & UX: AbortError is normal when switching tracks quickly (e.g. double tap)
            // We catch it silently. Other errors (404, network) still show alerts.
            if (err.name === 'AbortError') {
                console.log("Playback aborted (interrupted by new request).");
            } else {
                console.error("Playback failed:", err);
                alert("Playback failed. Check if server is running or file is accessible.");
            }
        }
    }

    toggle() {
        if (this.audio.paused) {
            this.audio.play();
        } else {
            this.audio.pause();
        }
    }

    play() { this.audio.play(); }
    pause() { this.audio.pause(); }

    async next() {
        const currentTrack = store.state.currentTrack;
        const mode = store.state.repeatMode;

        // Repeat (infinite): same song forever until user turns off or changes song
        if (mode === 'one' && currentTrack) {
            console.log("Repeat active, restarting track.");
            this.playTrack(currentTrack);
            return;
        }

        // Repeat(1): play current song one more time, then continue
        if (mode === 'once' && currentTrack) {
            if (this._repeatOnceUsedTrackId !== currentTrack.id) {
                this._repeatOnceUsedTrackId = currentTrack.id;
                console.log("Repeat once: playing again, then will continue.");
                this.playTrack(currentTrack);
                return;
            }
            this._repeatOnceUsedTrackId = null; // consumed; continue to next
        }

        // 1. Try Queue First
        console.log("Playing next track from queue...");
        const nextTrack = await store.popNextFromQueue();
        if (nextTrack) {
            this.playTrack(nextTrack);
            return;
        }

        // 2. Try Context Fallback (sequential or shuffled)
        if (this.currentContext && this.currentContext.length > 0 && store.state.currentTrack) {
            const currentIndex = this.currentContext.findIndex(t => t.id === store.state.currentTrack.id);
            const shuffleOn = store.state.shuffleEnabled;

            if (currentIndex !== -1 && currentIndex < this.currentContext.length - 1) {
                const nextTrack = shuffleOn
                    ? this._pickRandomFromContext(this.currentContext, store.state.currentTrack.id)
                    : this.currentContext[currentIndex + 1];
                if (nextTrack) {
                    console.log("Queue empty, falling back to context:", nextTrack.title, shuffleOn ? "(shuffle)" : "");
                    this.playTrack(nextTrack);
                    return;
                }
            }
        }

        console.log("Playback sequence finished.");
        this._invalidatePreload();
        store.update({ isPlaying: false, currentTrack: null });
    }

    async prev() {
        if (this.audio.currentTime > 3) {
            this.audio.currentTime = 0;
            return;
        }
        if (this.currentContext && this.currentContext.length > 0 && store.state.currentTrack) {
            const currentIndex = this.currentContext.findIndex(t => t.id === store.state.currentTrack.id);
            if (currentIndex > 0) {
                const prevTrack = this.currentContext[currentIndex - 1];
                this.playTrack(prevTrack);
                return;
            }
        }
    }

    seek(percent) {
        if (!this.audio.duration) return;
        const time = (percent / 100) * this.audio.duration;
        this.audio.currentTime = time;
        store.pushPlaybackState(store.state.currentTrack?.id, time, !this.audio.paused);
    }

    getVolume() {
        return this.audio.volume;
    }

    setVolume(value) {
        const v = Number(value);
        if (!Number.isFinite(v)) return;
        this.audio.volume = Math.min(1, Math.max(0, v));
    }

    _lastPushTime = 0;

    onTimeUpdate() {
        const duration = this.audio.duration || 0;
        const currentTime = this.audio.currentTime || 0;
        const progress = (currentTime / duration) * 100 || 0;
        const visible = isVisible();
        const pushDebounceSec = visible ? PUSH_DEBOUNCE_VISIBLE_SEC : PUSH_DEBOUNCE_HIDDEN_SEC;

        if (!this.audio.paused && store.state.currentTrack) {
            const now = Date.now() / 1000;
            if (now - this._lastPushTime >= pushDebounceSec) {
                this._lastPushTime = now;
                store.pushPlaybackState(store.state.currentTrack.id, currentTime, true);
            }
        }

        if (!this.audio.paused && Number.isFinite(duration) && duration > 0) {
            const remaining = duration - currentTime;
            if (remaining <= PRELOAD_THRESHOLD_SEC) {
                const nextTrack = this._getNextTrackForPreload();
                if (nextTrack && nextTrack.id !== this._preloadedTrackId) {
                    this._preloadTrack(nextTrack);
                }
            }
        }

        if (visible) {
            window.dispatchEvent(new CustomEvent('audio:timeupdate', {
                detail: { progress, currentTime, duration }
            }));
        }
    }
}

export const audioEngine = new AudioEngine();
