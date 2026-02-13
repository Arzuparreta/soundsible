/**
 * Web Audio Engine
 */
import { store } from './store.js';
import { Resolver } from './resolver.js';

class AudioEngine {
    constructor() {
        this.audio = new Audio();
        this.audio.crossOrigin = 'anonymous'; // Important for cross-device streaming
        this.init();
    }

    init() {
        this.audio.addEventListener('ended', () => this.next());
        this.audio.addEventListener('timeupdate', () => this.onTimeUpdate());
        this.audio.addEventListener('play', () => store.update({ isPlaying: true }));
        this.audio.addEventListener('pause', () => store.update({ isPlaying: false }));
        
        this.audio.addEventListener('error', (e) => {
            const error = this.audio.error;
            console.error("Audio Element Error:", error);
            const msg = error ? `Code ${error.code}: ${error.message}` : "Unknown audio error";
            alert(`Playback failed: ${msg}`);
        });

        // Handle Media Session API
        if ('mediaSession' in navigator) {
            navigator.mediaSession.setActionHandler('play', () => this.play());
            navigator.mediaSession.setActionHandler('pause', () => this.pause());
            navigator.mediaSession.setActionHandler('previoustrack', () => this.prev());
            navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
        }
    }

    async playTrack(track) {
        const url = Resolver.getTrackUrl(track);
        console.log("Playing URL:", url);
        
        try {
            this.audio.src = url;
            this.audio.load(); // Force reload for new source
            await this.audio.play();
            store.update({ currentTrack: track, isPlaying: true });

            // Update Media Session Metadata
            if ('mediaSession' in navigator) {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: track.title,
                    artist: track.artist,
                    album: track.album,
                    artwork: [
                        { src: 'assets/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
                        { src: 'assets/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
                    ]
                });
            }
        } catch (err) {
            console.error("Playback failed:", err);
            alert("Playback failed. Check if server is running or file is accessible.");
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

    next() {
        console.log("Next track (Not implemented yet)");
    }

    prev() {
        console.log("Prev track (Not implemented yet)");
    }

    onTimeUpdate() {
        const progress = (this.audio.currentTime / this.audio.duration) * 100;
        const el = document.getElementById('player-progress');
        if (el) el.style.width = `${progress}%`;
    }
}

export const audioEngine = new AudioEngine();
