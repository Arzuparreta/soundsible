/**
 * Web Audio Engine - Resilience & Hot-Swap Support
 */
import { store } from './store.js';
import { getApiBase } from './config.js';
import { Resolver } from './resolver.js';
import { connectionManager } from './connection.js';
import { Haptics } from './haptics.js';
import { isVisible } from './visibility.js';
import { radioService } from './radio.js';
import {
    playTimingNoteUserIntent,
    playTimingMarkSrcSet,
    playTimingMarkBeforePlay,
    playTimingMarkAfterPlayAwait,
    playTimingOnPlaying,
    isPlayTimingEligibleTrack,
} from './play_timing.js';
import { postSetupFirstPlayBeacon, ensureSetupSessionStarted } from './setup_funnel.js';
import { recordDiscoveryEvent } from './discovery_events.js';
import { MediaSessionBridge } from './media_session.js';
import { debugLog } from './debug.js';

const PRELOAD_THRESHOLD_SEC = 45;
const PUSH_DEBOUNCE_VISIBLE_SEC = 5;
const PUSH_DEBOUNCE_HIDDEN_SEC = 15;
class AudioEngine {
    constructor() {
        this.audio = new Audio();
        this.audio.crossOrigin = 'anonymous';
        this.currentPosition = 0;
        if (typeof window !== 'undefined') {
            void ensureSetupSessionStarted(store.apiBase);
        }
        this.currentContext = []; // Note: Sequential fallback
        /** Track ID we already repeated once in repeat(1) mode; cleared when song changes. */
        this._repeatOnceUsedTrackId = null;
        /** Auxiliary audio element for pre-loading next track URL (cache only; never play()). */
        this._preloadAudio = null;
        /** Track ID we last preloaded, to avoid re-preloading every timeupdate. */
        this._preloadedTrackId = null;
        /** Guard: only trigger "preview ended" once per track. */
        this._previewEndedTriggered = false;
        /** After starting a new track, ignore timeupdate with high currentTime (stale from previous track). */
        this._suppressStaleTimeUpdates = false;
        /** Serialize automatic advances; preview near-end and native ended can fire back-to-back. */
        this._advanceInFlight = null;
        this._pendingRemotePlayback = null;
        this._remoteUnlockOverlay = null;
        this._discoveryThirtySecondKeys = new Set();
        this.mediaSession = new MediaSessionBridge({
            getAudio: () => this.audio,
            getTrack: () => store.state.currentTrack,
            getCoverUrl: (track) => this._getMediaSessionCoverUrl(track),
            getFallbackArtwork: () => this._getMediaSessionFallbackArtwork(),
            actions: {
                play: () => this.play(),
                pause: () => this.pause(),
                previous: () => this.prev(),
                next: () => this.next(),
                seekRelative: (delta) => this.seekRelative(delta),
                seekTo: (positionSec) => this.seekToSeconds(positionSec),
            },
        });
        this.init();
    }

    _getMediaSessionCoverUrl(track) {
        if (track?.thumbnail) return track.thumbnail;
        return track?.id ? Resolver.getCoverUrl(track) : '';
    }

    _getMediaSessionFallbackArtwork() {
        return [
            { src: store.placeholderCoverUrl192 || 'assets/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: store.placeholderCoverUrl || 'assets/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
        ];
    }

    updateMediaSession(track = store.state.currentTrack) {
        this.mediaSession.updateTrack(track);
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
            // Note: Consumed; fall through to queue/context
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
        if (track.source === 'preview' || track.source === 'radio' || track.source === 'podcast-preview') return; // Note: Avoid hitting preview stream until user actually plays next
        if (typeof track.id === 'string' && track.id.startsWith('deezer_')) return; // Note: URL unknown until ODST resolve
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

    _isAutoplayBlocked(err) {
        const name = String(err?.name || '');
        const message = String(err?.message || '');
        return (
            name === 'NotAllowedError' ||
            /user.*interact|not allowed|play\(\) failed/i.test(message)
        );
    }

    _applyRequestedPosition(positionSec) {
        const position = Number(positionSec) || 0;
        if (position <= 0) return;
        const applySeek = () => {
            const duration = this.audio.duration;
            if (Number.isFinite(duration) && duration > 0) {
                this.audio.currentTime = Math.min(position, duration);
            }
        };
        if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
            applySeek();
        } else {
            this.audio.addEventListener('loadedmetadata', applySeek, { once: true });
        }
    }

    _stageRemotePlayback(track, positionSec = 0) {
        if (!track) return;
        this._pendingRemotePlayback = { track, positionSec: Number(positionSec) || 0 };
        store.update({ currentTrack: track, isPlaying: false });
        store.pushPlaybackState(track.id, Number(positionSec) || 0, false);
        this._showRemoteUnlockOverlay(track);
    }

    _hideRemoteUnlockOverlay() {
        if (this._remoteUnlockOverlay) {
            this._remoteUnlockOverlay.remove();
            this._remoteUnlockOverlay = null;
        }
    }

    _clearPendingRemotePlayback() {
        this._pendingRemotePlayback = null;
        this._hideRemoteUnlockOverlay();
    }

    _showRemoteUnlockOverlay(track) {
        if (typeof document === 'undefined') return;
        this._hideRemoteUnlockOverlay();
        const overlay = document.createElement('button');
        overlay.type = 'button';
        overlay.setAttribute('aria-label', 'Start remote playback');
        overlay.style.cssText = [
            'position:fixed',
            'left:50%',
            'bottom:calc(env(safe-area-inset-bottom, 0px) + 92px)',
            'transform:translateX(-50%)',
            'z-index:9999',
            'width:min(360px, calc(100vw - 32px))',
            'border:1px solid rgba(255,255,255,.16)',
            'border-radius:18px',
            'padding:14px 16px',
            'background:rgba(18,18,22,.94)',
            'color:#fff',
            'box-shadow:0 20px 60px rgba(0,0,0,.45)',
            'backdrop-filter:blur(18px) saturate(160%)',
            '-webkit-backdrop-filter:blur(18px) saturate(160%)',
            'font:600 14px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
            'text-align:left',
            'cursor:pointer'
        ].join(';');
        overlay.innerHTML = `
            <span style="display:block;font-size:12px;opacity:.72;margin-bottom:4px">Remote playback is ready</span>
            <span style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${this._escapeHtml(track.title || 'Start playback')}</span>
            <span style="display:block;font-size:12px;opacity:.72;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${this._escapeHtml(track.artist || '')}</span>
        `;
        overlay.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this._consumePendingRemotePlayback();
        });
        document.body.appendChild(overlay);
        this._remoteUnlockOverlay = overlay;
    }

    _escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[ch]);
    }

    _recordDiscoveryThirtySecondListen(track, currentTime) {
        if (!track || currentTime < 30) return;
        const key = `${track.source || 'library'}:${track.id}`;
        if (this._discoveryThirtySecondKeys.has(key)) return;
        this._discoveryThirtySecondKeys.add(key);
        if (track.media_kind === 'podcast_episode' || track.source === 'podcast-preview' || String(track.id || '').startsWith('pcast_')) {
            recordDiscoveryEvent('podcast_episode_played_30s', {
                media_type: 'podcast_episode',
                track_id: track._libraryTrackId || track.id,
                title: track.title || '',
                artist: track.artist || '',
                source: track.source || 'library',
                podcast_feed_id: track.podcast_feed_id || '',
                podcast_episode_id: track.podcast_episode_guid || track.id || '',
                podcast_show_title: track.artist || track.album || '',
            });
            return;
        }
        recordDiscoveryEvent('music_played_30s', {
            media_type: 'music_track',
            track_id: track._libraryTrackId || track.id,
            title: track.title || '',
            artist: track.artist || '',
            album: track.album || '',
            source: track.source || 'library',
            youtube_id: track.video_id || track.youtube_id || (String(track.id || '').length === 11 ? track.id : ''),
            deezer_id: track.deezerId || '',
        });
    }

    async _consumePendingRemotePlayback() {
        const pending = this._pendingRemotePlayback;
        if (!pending) return;
        this._pendingRemotePlayback = null;
        this._hideRemoteUnlockOverlay();
        const result = await this.playTrack(pending.track, {
            remoteRequest: true,
            positionSec: pending.positionSec,
            suppressAlerts: true,
            restageOnAutoplayBlock: false
        });
        if (result?.ok) this._applyRequestedPosition(pending.positionSec);
        else if (result?.blocked) this._stageRemotePlayback(pending.track, pending.positionSec);
    }

    setContext(tracks) {
        this.currentContext = tracks;
    }

    /**
     * Advance to a context or queue track: Deezer surface rows resolve to YouTube preview; everything else uses playTrack.
     * @param {unknown} track
     */
    async playContextTrack(track) {
        if (!track) return;
        if (typeof track.id === 'string' && track.id.startsWith('deezer_')) {
            const raw = track.id.replace(/^deezer_/, '');
            const ctx = Array.isArray(this.currentContext) && this.currentContext.length ? this.currentContext : [track];
            let idx = ctx.findIndex((t) => t && t.id === track.id);
            if (idx < 0 && track.deezerId != null) {
                idx = ctx.findIndex((t) => t && String(t.deezerId || '') === String(track.deezerId));
            }
            if (idx < 0) idx = 0;
            const m = await import('./discovery.js');
            if (typeof m.playDeezerTrackByNumericId === 'function') {
                await m.playDeezerTrackByNumericId(raw, { surfaceList: ctx, index: idx });
            }
            return;
        }
        await this.playTrack(track);
    }

    /** Pick a random track from context. If excludeId is set, exclude that track (avoids instant replay). */
    _pickRandomFromContext(context, excludeId) {
        const pool = excludeId ? context.filter(t => t.id !== excludeId) : [...context];
        if (pool.length === 0) return null;
        return pool[Math.floor(Math.random() * pool.length)];
    }

    init() {
        const v = store.state.volume;
        this.audio.volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
        this.audio.addEventListener('ended', () => { void this.next(); });
        this.audio.addEventListener('timeupdate', () => {
            this.currentPosition = this.audio.currentTime;
            this.mediaSession.updatePosition();
            this.onTimeUpdate();
        });
        
        this.audio.addEventListener('play', () => {
            if (store.state.resumeSyncActive) return;
            store.markUserPlaybackStarted();
            store.update({ isPlaying: true });
            store.pushPlaybackState(store.state.currentTrack?.id, this.audio.currentTime, true);
            this.mediaSession.updatePlaybackState();
            this.mediaSession.updatePosition(true);
            Haptics.heavy();
        });
        this.audio.addEventListener('pause', () => {
            if (store.state.resumeSyncActive) return;
            store.update({ isPlaying: false });
            store.pushPlaybackState(store.state.currentTrack?.id, this.audio.currentTime, false);
            this.mediaSession.updatePlaybackState();
            this.mediaSession.updatePosition(true);
            Haptics.lock();
        });
        this.audio.addEventListener('playing', () => {
            playTimingOnPlaying(store.state.currentTrack);
            this.updateMediaSession(store.state.currentTrack);
            const t = store.state.currentTrack;
            if (t && isPlayTimingEligibleTrack(t)) {
                postSetupFirstPlayBeacon(store.apiBase, t.id);
            }
        });
        
        this.audio.addEventListener('error', (e) => {
            console.error("Playback error:", this.audio.error);
            const track = store.state.currentTrack;
            store.update({ isPlaying: false });
            Haptics.error();
            if (
                (track?.source === 'preview' || track?.source === 'podcast-preview') &&
                typeof window.showToast === 'function'
            ) {
                window.showToast('Preview unavailable');
            }
        });

        this.setMediaSessionHandlers();

        setInterval(() => {
            if (store.state.resumeSyncActive) return;
            if (isVisible() && typeof document !== 'undefined' && document.hasFocus() && store.state.currentTrack) {
                store.pushPlaybackState(store.state.currentTrack.id, this.audio.currentTime, !this.audio.paused);
            }
        }, 20000);

        // Note: Stop when another device resumes (server sends playback_stop_requested)
        if (typeof window !== 'undefined') {
            window.addEventListener('playback_stop_requested', () => this.pause());
            window.addEventListener('playback_next_requested', () => this.next());
            window.addEventListener('playback_previous_requested', () => this.prev());
            window.addEventListener('playback_seek_requested', (event) => {
                const positionSec = Number(event.detail?.position_sec);
                this.seekToSeconds(positionSec);
            });
            window.addEventListener('playback_start_requested', async (event) => {
                const detail = event.detail || {};
                const state = detail.state || {};
                const trackId = state.track_id;
                let track = detail.track || null;
                if (!track && trackId) {
                    track = store.state.library.find(t => t.id === trackId) || null;
                    if (!track) {
                        await store.syncLibrary().catch(() => {});
                        track = store.state.library.find(t => t.id === trackId) || null;
                    }
                }
                if (!track) return;
                const positionSec = Number(state.position_sec) || 0;
                const result = await this.playTrack(track, {
                    remoteRequest: true,
                    positionSec,
                    suppressAlerts: true
                });
                if (result?.ok) this._applyRequestedPosition(positionSec);
            });
        }

        // Note: Persist playback state on close so same-device resume works after reload
        const pushStateOnUnload = () => {
            if (store.state.currentTrack) {
                const time = Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0;
                store.pushPlaybackState(store.state.currentTrack.id, time, false);
            }
        };
        if (typeof window !== 'undefined') {
            window.addEventListener('beforeunload', pushStateOnUnload);
            window.addEventListener('pagehide', pushStateOnUnload);
        }
    }

    /** Set Media Session action handlers for browser/OS media controls. */
    setMediaSessionHandlers() {
        this.mediaSession.installHandlers();
    }

    /**
     * Preview tracks use GET /api/preview/stream/<id> (server proxies YT audio; same-origin so playback works).
     * Single path for all in-app preview (Discover, Search, queue, context).
     */
    async playTrack(track, options = {}) {
        if (track?.source === 'preview-pending') {
            return { ok: false };
        }
        // Note: Mark immediately (before await play) so post-sync resume logic cannot race the play event.
        if (!store.state.resumeSyncActive && !options.remoteRequest) {
            store.markUserPlaybackStarted();
        }
        // Note: Any song change (different track) resets repeat
        if (store.state.currentTrack && track.id !== store.state.currentTrack.id) {
            store.update({ repeatMode: 'off' });
            this._repeatOnceUsedTrackId = null;
        }

        // Note: Prevent redundant loads if tapping the same track rapidly
        if (this.audio.src.includes(track.id) && !this.audio.paused) {
            debugLog("Track already playing, ignoring redundant request.");
            return { ok: true, alreadyPlaying: true };
        }

        if (options.playTimingIntent && !options.remoteRequest && isPlayTimingEligibleTrack(track)) {
            playTimingNoteUserIntent(track.id);
        }

        this._invalidatePreload();

        if (track.source === 'podcast-preview') {
            this._previewEndedTriggered = false;
            const host =
                typeof store !== 'undefined' && store.state && store.state.activeHost
                    ? store.state.activeHost
                    : typeof window !== 'undefined' && window.location
                      ? window.location.hostname
                      : 'localhost';
            const apiBase = getApiBase(host);
            let tok = track._streamToken;
            // Note: If no token (e.g. from queue), fetch one from enclosure_url
            if (!tok && track.enclosure_url) {
                try {
                    const r = await fetch(`${apiBase}/api/podcasts/enclosure/peek`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ enclosure_url: track.enclosure_url })
                    });
                    const d = await r.json().catch(() => ({}));
                    if (r.ok && d.stream_token) tok = d.stream_token;
                } catch (_) {}
            }
            if (!tok) {
                if (typeof window.showToast === 'function') window.showToast('Preview unavailable');
                return { ok: false };
            }
            const streamUrl = `${apiBase}/api/podcasts/stream/${encodeURIComponent(tok)}`;
            try {
                this.audio.src = streamUrl;
                this.audio.load();
                await this.audio.play();
                this._clearPendingRemotePlayback();
                const playbackTrack = { ...track, _streamToken: tok };
                store.update({ currentTrack: playbackTrack, isPlaying: true });
                store.pushPlaybackState(track.id, 0, true);
                this._suppressStaleTimeUpdates = true;
                this._dispatchTimeUpdate(0, 0, track?.duration ?? 0);
                this.updateMediaSession(playbackTrack);
                return { ok: true };
            } catch (err) {
                if (options.remoteRequest && this._isAutoplayBlocked(err)) {
                    if (options.restageOnAutoplayBlock !== false) this._stageRemotePlayback(track, options.positionSec);
                    return { ok: false, blocked: true };
                }
                store.update({ isPlaying: false });
                console.error('Podcast preview playback failed:', err);
                return { ok: false, error: err };
            }
            return { ok: false };
        }

        // Note: Preview/radio stream through our server (same-origin) so playback works. direct YT urls are CORS-blocked.
        // Note: Always use HTTP; app and API are never HTTPS.
        if (track.source === 'preview' || track.source === 'radio') {
            this._previewEndedTriggered = false;
            const host = (typeof store !== 'undefined' && store.state && store.state.activeHost) ? store.state.activeHost : (typeof window !== 'undefined' && window.location ? window.location.hostname : 'localhost');
            const apiBase = getApiBase(host);
            let streamUrl;
            const ytId = track.video_id || (track.id && !String(track.id).startsWith('raw-') && String(track.id).length === 11 ? track.id : null);
            const libraryTrackId = track._libraryTrackId || (ytId ? (store.state.youtubeToTrackId || {})[ytId] : null);
            const playbackTrack = libraryTrackId ? { ...track, _libraryTrackId: libraryTrackId } : track;
            if (libraryTrackId) {
                streamUrl = `${apiBase}/api/static/stream/${encodeURIComponent(libraryTrackId)}`;
            } else {
                if (!ytId) {
                    if (typeof window.showToast === 'function') window.showToast('Preview unavailable');
                    return { ok: false };
                }
                streamUrl = `${apiBase}/api/preview/stream/${encodeURIComponent(ytId)}`;
            }
            try {
                this.audio.src = streamUrl;
                this.audio.load();
                await this.audio.play();
                this._clearPendingRemotePlayback();
                store.update({ currentTrack: playbackTrack, isPlaying: true });
                store.pushPlaybackState(playbackTrack.id, 0, true);
                this._suppressStaleTimeUpdates = true;
                this._dispatchTimeUpdate(0, 0, playbackTrack?.duration ?? 0);
                this.updateMediaSession(playbackTrack);
                return { ok: true };
            } catch (err) {
                if (options.remoteRequest && this._isAutoplayBlocked(err)) {
                    if (options.restageOnAutoplayBlock !== false) this._stageRemotePlayback(track, options.positionSec);
                    return { ok: false, blocked: true };
                }
                store.update({ isPlaying: false });
                // Note: Don't toast here the audio 'error' listener already shows "preview unavailable" when load fails
                console.error("Preview playback failed:", err);
                return { ok: false, error: err };
            }
            return { ok: false };
        }

        const url = Resolver.getTrackUrl(track);
        debugLog("Playing URL:", url);

        const playTimingLib =
            options.playTimingIntent && !options.remoteRequest && isPlayTimingEligibleTrack(track);

        try {
            this.audio.src = url;
            this.audio.load();
            if (playTimingLib) playTimingMarkSrcSet(track.id);
            if (playTimingLib) playTimingMarkBeforePlay(track.id);
            await this.audio.play();
            if (playTimingLib) playTimingMarkAfterPlayAwait(track.id);
            this._clearPendingRemotePlayback();
            store.update({ currentTrack: track, isPlaying: true });
            store.pushPlaybackState(track.id, 0, true);
            this._suppressStaleTimeUpdates = true;
            this._dispatchTimeUpdate(0, 0, track?.duration ?? 0);
            this.updateMediaSession(track);
            return { ok: true };
        } catch (err) {
            // Note: Security & UX aborterror is normal when switching tracks quickly (e.g. double tap)
            // Note: We catch it silently. other errors (404, network) still show alerts.
            if (err.name === 'AbortError') {
                debugLog("Playback aborted (interrupted by new request).");
                return { ok: false, aborted: true };
            } else if (options.remoteRequest && this._isAutoplayBlocked(err)) {
                if (options.restageOnAutoplayBlock !== false) this._stageRemotePlayback(track, options.positionSec);
                return { ok: false, blocked: true };
            } else {
                console.error("Playback failed:", err);
                if (!options.suppressAlerts) alert("Playback failed. Check if server is running or file is accessible.");
                return { ok: false, error: err };
            }
        }
    }

    isAudiblyPlaying() {
        const audio = this.audio;
        return !!(audio && !audio.paused && !audio.ended);
    }

    /** Mirror `<audio>` play state into the store (skipped during resume-sync). */
    syncPlayingStateToStore() {
        if (store.state.resumeSyncActive) return;
        const isPlaying = this.isAudiblyPlaying();
        if (store.state.isPlaying !== isPlaying) {
            store.update({ isPlaying });
        }
    }

    toggle() {
        if (this.audio.paused) {
            void this.audio.play()
                .then(() => this.syncPlayingStateToStore())
                .catch(() => this.syncPlayingStateToStore());
        } else {
            this.audio.pause();
            this.syncPlayingStateToStore();
        }
    }

    play() {
        void this.audio.play()
            .then(() => this.syncPlayingStateToStore())
            .catch(() => this.syncPlayingStateToStore());
    }

    pause() {
        this.audio.pause();
        this.syncPlayingStateToStore();
    }

    _shouldAutoContinuePreview(track) {
        if (!track || store.state.radioMode) return false;
        if (track.source === 'podcast-preview') return false;
        if (track.source === 'preview') return true;
        return track.source === 'radio' && !track._libraryTrackId;
    }

    async _startPreviewContinuation(track) {
        if (!this._shouldAutoContinuePreview(track)) return false;
        const radioTrack = await radioService.startContinuation(track);
        if (!radioTrack) return false;
        await this.playTrack(radioTrack);
        return true;
    }

    async next() {
        if (this._advanceInFlight) return this._advanceInFlight;
        this._advanceInFlight = this._advanceToNext();
        try {
            return await this._advanceInFlight;
        } finally {
            this._advanceInFlight = null;
        }
    }

    async _advanceToNext() {
        const currentTrack = store.state.currentTrack;
        const mode = store.state.repeatMode;

        // Note: Repeat (infinite) same song forever until user turns off or changes song
        if (mode === 'one' && currentTrack) {
            debugLog("Repeat active, restarting track.");
            await this.playTrack(currentTrack);
            return;
        }

        // Note: Repeat(1) play current song one more time, then continue
        if (mode === 'once' && currentTrack) {
            if (this._repeatOnceUsedTrackId !== currentTrack.id) {
                this._repeatOnceUsedTrackId = currentTrack.id;
                debugLog("Repeat once: playing again, then will continue.");
                await this.playTrack(currentTrack);
                return;
            }
            this._repeatOnceUsedTrackId = null; // Note: Consumed; continue to next
        }

        // Note: 1. User-managed queue always takes priority, even while radio is active.
        debugLog("Playing next track from queue...");
        const nextTrack = await store.popNextFromQueue();
        if (nextTrack) {
            await this.playContextTrack(nextTrack);
            return;
        }

        // Note: 1b. Queue empty — radio supplies hidden generated tracks without touching the queue.
        if (store.state.radioMode) {
            const radioTrack = await radioService.nextTrack();
            if (radioTrack) {
                await this.playTrack(radioTrack);
                return;
            }
            radioService.exitRadio();
            window.showToast?.('Radio ended');
        }

        // Note: A music preview with no explicit queue should continue as a radio session, but skip the seed already heard.
        if (await this._startPreviewContinuation(currentTrack)) return;

        // Note: 2. Try context fallback (sequential or shuffled)
        if (this.currentContext && this.currentContext.length > 0 && store.state.currentTrack) {
            const currentIndex = this.currentContext.findIndex(t => t.id === store.state.currentTrack.id);
            const shuffleOn = store.state.shuffleEnabled;

            if (currentIndex !== -1 && currentIndex < this.currentContext.length - 1) {
                const nextTrack = shuffleOn
                    ? this._pickRandomFromContext(this.currentContext, store.state.currentTrack.id)
                    : this.currentContext[currentIndex + 1];
                if (nextTrack) {
                    debugLog("Queue empty, falling back to context:", nextTrack.title, shuffleOn ? "(shuffle)" : "");
                    await this.playContextTrack(nextTrack);
                    return;
                }
            }
        }

        debugLog("Playback sequence finished.");
        this._invalidatePreload();
        const isPreview =
            currentTrack?.source === 'preview' || currentTrack?.source === 'radio' || currentTrack?.source === 'podcast-preview';
        if (isPreview) {
            store.update({ isPlaying: false });
            this.mediaSession.updatePlaybackState();
        } else {
            store.update({ isPlaying: false, currentTrack: null });
            this.updateMediaSession(null);
        }
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
                void this.playContextTrack(prevTrack);
                return;
            }
        }
    }

    seek(percent) {
        if (!this.audio.duration) return;
        const time = (percent / 100) * this.audio.duration;
        this.seekToSeconds(time);
    }

    seekRelative(deltaSec) {
        const delta = Number(deltaSec);
        if (!Number.isFinite(delta)) return false;
        const duration = Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
        const current = Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0;
        const target = duration > 0
            ? Math.max(0, Math.min(duration, current + delta))
            : Math.max(0, current + delta);
        return this.seekToSeconds(target);
    }

    seekToSeconds(positionSec) {
        const position = Number(positionSec);
        if (!Number.isFinite(position) || position < 0) return false;
        const applySeek = () => {
            const duration = this.audio.duration;
            const target = Number.isFinite(duration) && duration > 0
                ? Math.min(position, duration)
                : position;
            try {
                this.audio.currentTime = target;
            } catch (err) {
                console.error("Seek failed:", err);
                return false;
            }
            this.currentPosition = target;
            store.pushPlaybackState(store.state.currentTrack?.id, target, !this.audio.paused);
            const effectiveDuration = Number.isFinite(duration) && duration > 0
                ? duration
                : Number(store.state.currentTrack?.duration) || 0;
            const progress = effectiveDuration > 0 ? (target / effectiveDuration) * 100 : 0;
            this._dispatchTimeUpdate(progress, target, effectiveDuration);
            this.mediaSession.updatePosition(true);
            return true;
        };

        if (this.audio.readyState >= 1) return applySeek();
        this.audio.addEventListener('loadedmetadata', applySeek, { once: true });
        return true;
    }

    getVolume() {
        return this.audio.volume;
    }

    setVolume(value) {
        const v = Number(value);
        if (!Number.isFinite(v)) return;
        this.audio.volume = Math.min(1, Math.max(0, v));
    }

    /** Single entry point for progress/currentTime/duration to UI: used by onTimeUpdate and when starting a new track (reset to 0). */
    _dispatchTimeUpdate(progress, currentTime, duration) {
        if (typeof window !== 'undefined' && window.dispatchEvent) {
            window.dispatchEvent(new CustomEvent('audio:timeupdate', { detail: { progress, currentTime, duration } }));
        }
    }

    _lastPushTime = 0;

    onTimeUpdate() {
        const rawDuration = this.audio.duration;
        const trackDuration = store.state.currentTrack?.duration;
        const duration = (Number.isFinite(rawDuration) && rawDuration > 0) ? rawDuration : (Number(trackDuration) || 0);
        const currentTime = this.audio.currentTime || 0;
        const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

        if (store.state.resumeSyncActive) {
            this.currentPosition = currentTime;
            if (isVisible()) this._dispatchTimeUpdate(progress, currentTime, duration);
            return;
        }

        const currentTrack = store.state.currentTrack;
        if (
            (
                currentTrack?.source === 'preview' ||
                (currentTrack?.source === 'radio' && !currentTrack?._libraryTrackId) ||
                currentTrack?.source === 'podcast-preview'
            ) &&
            duration > 0 &&
            !this._previewEndedTriggered &&
            currentTime >= duration - 1.2
        ) {
            this._previewEndedTriggered = true;
            void this.next();
        }

        const visible = isVisible();
        const pushDebounceSec = visible ? PUSH_DEBOUNCE_VISIBLE_SEC : PUSH_DEBOUNCE_HIDDEN_SEC;

        if (!this.audio.paused && currentTrack) {
            const now = Date.now() / 1000;
            if (now - this._lastPushTime >= pushDebounceSec) {
                this._lastPushTime = now;
                store.pushPlaybackState(currentTrack.id, currentTime, true);
            }
            this._recordDiscoveryThirtySecondListen(currentTrack, currentTime);
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

        if (this._suppressStaleTimeUpdates) {
            if (currentTime > 0.5) return;
            this._suppressStaleTimeUpdates = false;
        }
        if (visible) this._dispatchTimeUpdate(progress, currentTime, duration);
    }
}

export const audioEngine = new AudioEngine();
