/**
 * Radio Mode — Spotify-style radio from any seed track.
 * Uses YouTube Music Mix playlists as the recommendation engine.
 */
import { store } from './store.js';
import { getApiBase } from './config.js';
import { audioEngine } from './audio.js';
import { searchService } from './search_service.js';
import { showLoadingToast } from './shared.js';

const REFILL_THRESHOLD = 3;
const MAX_QUEUE_BATCH = 25;
const RELATED_CACHE_TTL = 5 * 60 * 1000;

/** Tracks we've already played in this radio session (to avoid repeats). */
const playedIds = new Set();
/** Cache related results per video ID. */
const relatedCache = new Map();

function isYoutubeVideoId(id) {
    return typeof id === 'string' && id.length === 11 && !id.startsWith('raw-');
}

async function fetchRelatedVideos(videoId, limit = MAX_QUEUE_BATCH) {
    const cacheKey = `${videoId}:${limit}`;
    const cached = relatedCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < RELATED_CACHE_TTL) return cached.data;

    const host = store?.state?.activeHost || window.location.hostname || 'localhost';
    const apiBase = getApiBase(host);
    try {
        const res = await fetch(`${apiBase}/api/downloader/youtube/related?id=${encodeURIComponent(videoId)}&limit=${limit}`);
        if (!res.ok) return [];
        const data = await res.json();
        const results = Array.isArray(data.results) ? data.results : [];
        relatedCache.set(cacheKey, { data: results, ts: Date.now() });
        return results;
    } catch {
        return [];
    }
}

function makeSessionId() {
    return `radio_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function rowToRadioTrack(row) {
    if (!row || !isYoutubeVideoId(row.id)) return null;
    const ch = typeof row.channel === 'string' ? row.channel.trim() : '';
    const art = typeof row.artist === 'string' ? row.artist.trim() : '';
    const artist = art || ch || '';
    return {
        id: row.id,
        video_id: row.id,
        title: row.title || 'Unknown',
        artist,
        channel: artist,
        duration: row.duration || 0,
        thumbnail: row.thumbnail || '',
        source: 'radio'
    };
}

function getTrackVideoId(track) {
    if (!track) return null;
    if (isYoutubeVideoId(track.video_id)) return track.video_id;
    if ((track.source === 'preview' || track.source === 'radio') && isYoutubeVideoId(track.id)) return track.id;
    if (isYoutubeVideoId(track.youtube_id)) return track.youtube_id;
    return null;
}

function getLibraryTrackId(track, seedVideoId) {
    if (!track) return null;
    if (track._libraryTrackId || track.library_track_id) return track._libraryTrackId || track.library_track_id;
    if (track.youtube_id === seedVideoId && typeof track.id === 'string' && !track.id.startsWith('deezer_') && !track.id.startsWith('pcast_')) {
        return track.id;
    }
    if (
        (track.source === 'library' || track.file_hash || track.local_path || track.original_filename) &&
        typeof track.id === 'string' &&
        !track.id.startsWith('deezer_') &&
        !track.id.startsWith('pcast_')
    ) {
        return track.id;
    }
    return null;
}

function localCoverUrl(trackId) {
    if (!trackId) return '';
    const host = store?.state?.activeHost || window.location.hostname || 'localhost';
    return `${getApiBase(host)}/api/static/cover/${encodeURIComponent(trackId)}`;
}

function makeSeedRadioTrack(track, seed) {
    const libraryTrackId = getLibraryTrackId(track, seed.videoId);
    const thumbnail = track.thumbnail || track.cover || track.cover_url || track.album_art_url || localCoverUrl(libraryTrackId);
    return {
        id: seed.videoId,
        video_id: seed.videoId,
        title: seed.title || track.title || 'Unknown',
        artist: seed.artist || track.artist || track.album_artist || track.channel || '',
        album: track.album,
        duration: Math.max(0, Number(track.duration || track.duration_sec || 0) || 0),
        thumbnail,
        source: 'radio',
        ...(libraryTrackId ? { _libraryTrackId: libraryTrackId } : {})
    };
}

function isSamePlaybackTarget(track, currentTrack, seedVideoId) {
    if (!track || !currentTrack) return false;
    if (track.id && currentTrack.id && track.id === currentTrack.id) return true;
    const currentVideoId = getTrackVideoId(currentTrack);
    if (currentVideoId && currentVideoId === seedVideoId) return true;
    const libraryTrackId = getLibraryTrackId(track, seedVideoId);
    if (libraryTrackId && (currentTrack.id === libraryTrackId || currentTrack._libraryTrackId === libraryTrackId)) return true;
    return false;
}

/**
 * Resolve a track to its YouTube video_id.
 * Handles: library tracks (with youtube_id), Deezer tracks, preview tracks.
 * @param {object} track
 * @returns {Promise<{ videoId: string, title: string, artist: string } | null>}
 */
async function resolveSeedVideoId(track) {
    if (!track) return null;
    if (
        track.media_kind === 'podcast_episode' ||
        track.source === 'podcast-preview' ||
        (typeof track.id === 'string' && track.id.startsWith('pcast_'))
    ) {
        return null;
    }
    const title = (track.title || '').trim();
    const artist = (track.artist || track.album_artist || track.channel || '').trim();

    // Preview track: already has a YouTube video_id
    if (track.source === 'preview' && isYoutubeVideoId(track.id)) {
        return { videoId: track.id, title, artist };
    }

    // Library track with linked YouTube ID
    if (track.youtube_id && isYoutubeVideoId(track.youtube_id)) {
        return { videoId: track.youtube_id, title, artist };
    }

    // Deezer track: resolve via YouTube search
    if (typeof track.id === 'string' && track.id.startsWith('deezer_')) {
        const { resolveDeezerTrackToOdstItem } = await import('./discovery.js');
        const like = { title, artist, deezerId: track.deezerId };
        const odst = await resolveDeezerTrackToOdstItem(like);
        if (odst && isYoutubeVideoId(odst.id)) {
            return { videoId: odst.id, title: odst.title || title, artist: odst.artist || artist };
        }
        return null;
    }

    // Library track without YouTube ID: search YouTube
    if (title) {
        const q = `${title} ${artist}`.trim();
        try {
            const results = await searchService.query(q, { debounce: 0, isolated: true });
            if (results && results.length) {
                for (const row of results) {
                    if (isYoutubeVideoId(row.id)) {
                        return { videoId: row.id, title, artist };
                    }
                }
            }
        } catch {}
    }

    return null;
}

class RadioService {
    constructor() {
        this._refilling = false;
        this._refillPromise = null;
        this._buffer = [];
    }

    _statePatch(patch) {
        const current = store.state.radioMode;
        if (!current) return;
        store.update({ radioMode: { ...current, ...patch } });
    }

    _rememberPlayed(videoId) {
        if (isYoutubeVideoId(videoId)) playedIds.add(videoId);
    }

    async _appendRelated(seedVideoId) {
        if (!isYoutubeVideoId(seedVideoId)) return 0;
        const related = await fetchRelatedVideos(seedVideoId);
        if (!related.length) return 0;

        const newItems = [];
        for (const row of related) {
            if (playedIds.has(row.id)) continue;
            const item = rowToRadioTrack(row);
            if (item) {
                newItems.push(item);
                playedIds.add(item.video_id);
            }
        }

        if (!newItems.length) return 0;
        this._buffer.push(...newItems);
        const current = store.state.radioMode;
        if (current) {
            store.update({
                radioMode: {
                    ...current,
                    activeVideoId: seedVideoId,
                    bufferCount: this._buffer.length,
                    generatedCount: (current.generatedCount || 0) + newItems.length,
                    isFetching: false
                }
            });
        }
        return newItems.length;
    }

    /**
     * Start radio mode from a seed track.
     * @param {object} track - The seed track (library, Deezer, or preview)
     * @returns {Promise<boolean>} true if radio started successfully
     */
    async startRadio(track) {
        if (store.state.radioMode) this.exitRadio();

        const loading = showLoadingToast('Starting radio...');

        try {
            const seed = await resolveSeedVideoId(track);
            if (!seed) {
                loading.dismiss();
                window.showToast?.('Could not find this track on YouTube');
                return false;
            }

            this._buffer = [];
            playedIds.clear();
            playedIds.add(seed.videoId);

            store.update({
                radioMode: {
                    sessionId: makeSessionId(),
                    enabled: true,
                    seedVideoId: seed.videoId,
                    seedTitle: seed.title,
                    seedArtist: seed.artist,
                    activeVideoId: seed.videoId,
                    bufferCount: 0,
                    generatedCount: 0,
                    isFetching: true
                }
            });

            const added = await this._appendRelated(seed.videoId);
            if (!added) {
                this.exitRadio();
                loading.dismiss();
                window.showToast?.('No related tracks found');
                return false;
            }

            const seedTrack = makeSeedRadioTrack(track, seed);
            const alreadyPlayingSeed = store.state.isPlaying && isSamePlaybackTarget(track, store.state.currentTrack, seed.videoId);
            this._statePatch({ currentVideoId: seed.videoId });
            if (alreadyPlayingSeed) {
                store.update({ currentTrack: seedTrack });
            } else {
                await audioEngine.playTrack(seedTrack);
            }

            loading.dismiss();
            return true;
        } catch (err) {
            loading.dismiss();
            window.showToast?.('Could not start radio');
            console.error('Radio start error:', err);
            return false;
        }
    }

    /**
     * Refill the hidden radio buffer if running low. Uses the currently playing track as a new seed for variety.
     * @returns {Promise<boolean>} true if refilled successfully
     */
    async refillIfNeeded() {
        if (!store.state.radioMode) return false;
        if (this._refilling) return this._refillPromise || false;
        if (this._buffer.length > REFILL_THRESHOLD) return false;

        const currentTrack = store.state.currentTrack;
        if (!currentTrack) return false;

        const currentVideoId = currentTrack.video_id || currentTrack.id;
        if (!isYoutubeVideoId(currentVideoId)) return false;

        this._refilling = true;
        this._statePatch({ isFetching: true });
        this._refillPromise = (async () => {
            const added = await this._appendRelated(currentVideoId);
            if (added > 0) return true;
            this._statePatch({ isFetching: false });
            return false;
        })();
        try {
            return await this._refillPromise;
        } catch (err) {
            console.error('Radio refill error:', err);
            this._statePatch({ isFetching: false });
            return false;
        } finally {
            this._refilling = false;
            this._refillPromise = null;
        }
    }

    async nextTrack() {
        if (!store.state.radioMode) return null;
        if (this._buffer.length === 0) {
            await this.refillIfNeeded();
        } else if (this._buffer.length <= REFILL_THRESHOLD) {
            void this.refillIfNeeded();
        }
        let next = this._buffer.shift();
        if (!next) return null;
        this._rememberPlayed(next.video_id || next.id);
        this._statePatch({
            currentVideoId: next.video_id || next.id,
            bufferCount: this._buffer.length
        });
        return next;
    }

    /**
     * Exit radio mode. Does not clear the queue.
     */
    exitRadio() {
        if (!store.state.radioMode) return;
        this._buffer = [];
        playedIds.clear();
        store.update({ radioMode: null });
    }

    /**
     * @returns {boolean}
     */
    isInRadioMode() {
        return store.state.radioMode !== null;
    }
}

export const radioService = new RadioService();
