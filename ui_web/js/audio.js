/**
 * Web Audio Engine - Resilience & Hot-Swap Support
 */
import { store } from './store.js';
import { Resolver } from './resolver.js';
import { connectionManager } from './connection.js';
import { Haptics } from './haptics.js';

class AudioEngine {
    constructor() {
        this.audio = new Audio();
        this.audio.crossOrigin = 'anonymous';
        this.currentPosition = 0;
        this.currentContext = []; // Sequential fallback
        this.init();
    }

    setContext(tracks) {
        this.currentContext = tracks;
    }

    init() {
        this.audio.addEventListener('ended', () => this.next());
        this.audio.addEventListener('timeupdate', () => {
            this.currentPosition = this.audio.currentTime;
            this.onTimeUpdate();
        });
        
        this.audio.addEventListener('play', () => {
            store.update({ isPlaying: true });
            Haptics.heavy();
        });
        this.audio.addEventListener('pause', () => {
            store.update({ isPlaying: false });
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
        // Prevent redundant loads if tapping the same track rapidly
        if (this.audio.src.includes(track.id) && !this.audio.paused) {
            console.log("Track already playing, ignoring redundant request.");
            return;
        }

        const url = Resolver.getTrackUrl(track);
        console.log("Playing URL:", url);
        
        try {
            this.audio.src = url;
            this.audio.load();
            await this.audio.play();
            store.update({ currentTrack: track, isPlaying: true });

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
        if (store.state.repeatMode === 'one' && store.state.currentTrack) {
            console.log("Repeat One active, restarting track.");
            this.playTrack(store.state.currentTrack);
            return;
        }

        // 1. Try Queue First
        console.log("Playing next track from queue...");
        const nextTrack = await store.popNextFromQueue();
        if (nextTrack) {
            this.playTrack(nextTrack);
            return;
        }

        // 2. Try Context Fallback (Sequential Play)
        if (this.currentContext && this.currentContext.length > 0 && store.state.currentTrack) {
            const currentIndex = this.currentContext.findIndex(t => t.id === store.state.currentTrack.id);
            
            if (currentIndex !== -1 && currentIndex < this.currentContext.length - 1) {
                const nextSeqTrack = this.currentContext[currentIndex + 1];
                console.log("Queue empty, falling back to context sequence:", nextSeqTrack.title);
                this.playTrack(nextSeqTrack);
                return;
            } else if (store.state.repeatMode === 'all') {
                console.log("End of context reached, Repeat All active. Looping...");
                this.playTrack(this.currentContext[0]);
                return;
            }
        }

        console.log("Playback sequence finished.");
        store.update({ isPlaying: false, currentTrack: null });
    }

    async prev() {
        // Prev is tricky without a history stack, for now we just restart current track
        // if we are more than 3 seconds in, otherwise we can't do much without a proper history.
        if (this.audio.currentTime > 3) {
            this.audio.currentTime = 0;
        } else {
            console.log("Prev track (Not implemented: History stack needed)");
        }
    }

    seek(percent) {
        if (!this.audio.duration) return;
        const time = (percent / 100) * this.audio.duration;
        this.audio.currentTime = time;
    }

    onTimeUpdate() {
        const duration = this.audio.duration || 0;
        const currentTime = this.audio.currentTime || 0;
        const progress = (currentTime / duration) * 100 || 0;
        
        // Update Mini-bar
        const el = document.getElementById('player-progress');
        if (el) el.style.width = `${progress}%`;

        // Broadcast for Now Playing view
        window.dispatchEvent(new CustomEvent('audio:timeupdate', { 
            detail: { progress, currentTime, duration } 
        }));
    }
}

export const audioEngine = new AudioEngine();
