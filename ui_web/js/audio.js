/**
 * Web Audio Engine - Resilience & Hot-Swap Support
 */
import { store } from './store.js';
import { Resolver } from './resolver.js';
import { connectionManager } from './connection.js';

class AudioEngine {
    constructor() {
        this.audio = new Audio();
        this.audio.crossOrigin = 'anonymous';
        this.currentPosition = 0;
        this.init();
    }

    init() {
        this.audio.addEventListener('ended', () => this.next());
        this.audio.addEventListener('timeupdate', () => {
            this.currentPosition = this.audio.currentTime;
            this.onTimeUpdate();
        });
        
        this.audio.addEventListener('play', () => store.update({ isPlaying: true }));
        this.audio.addEventListener('pause', () => store.update({ isPlaying: false }));
        
        this.audio.addEventListener('error', (e) => {
            console.error("Playback error:", this.audio.error);
            store.update({ isPlaying: false });
        });

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
            this.audio.load();
            await this.audio.play();
            store.update({ currentTrack: track, isPlaying: true });

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

    next() { console.log("Next track (Pending queue implementation)"); }
    prev() { console.log("Prev track (Pending queue implementation)"); }

    onTimeUpdate() {
        const progress = (this.audio.currentTime / this.audio.duration) * 100;
        const el = document.getElementById('player-progress');
        if (el) el.style.width = `${progress}%`;
    }
}

export const audioEngine = new AudioEngine();
