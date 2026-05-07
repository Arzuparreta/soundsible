/**
 * Radio Mode — Spotify-style radio from any seed track.
 * Uses YouTube Music Mix playlists as the recommendation engine.
 */
import { store } from './store.js';
import { getApiBase } from './config.js';
import { audioEngine } from './audio.js';
import { searchService } from './search_service.js';
import { showLoadingToast } from './shared.js';

const REFILL_THRESHOLD = 2;
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

function rowToPreviewItem(row) {
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
        thumbnail: row.thumbnail || ''
    };
}

/**
 * Resolve a track to its YouTube video_id.
 * Handles: library tracks (with youtube_id), Deezer tracks, preview tracks.
 * @param {object} track
 * @returns {Promise<{ videoId: string, title: string, artist: string } | null>}
 */
async function resolveSeedVideoId(track) {
    if (!track) return null;
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
    }

    /**
     * Start radio mode from a seed track.
     * @param {object} track - The seed track (library, Deezer, or preview)
     * @returns {Promise<boolean>} true if radio started successfully
     */
    async startRadio(track) {
        if (store.state.radioMode) this.exitRadio();

        const title = (track.title || 'Unknown').trim();
        const artist = (track.artist || track.album_artist || track.channel || '').trim();
        const loading = showLoadingToast(`Starting radio for "${title}"...`);

        try {
            const seed = await resolveSeedVideoId(track);
            if (!seed) {
                loading.dismiss();
                window.showToast?.('Could not find this track on YouTube');
                return false;
            }

            const related = await fetchRelatedVideos(seed.videoId);
            if (!related.length) {
                loading.dismiss();
                window.showToast?.('No related tracks found');
                return false;
            }

            playedIds.clear();
            playedIds.add(seed.videoId);

            const previewItems = [];
            for (const row of related) {
                if (playedIds.has(row.id)) continue;
                const item = rowToPreviewItem(row);
                if (item) {
                    previewItems.push(item);
                    playedIds.add(item.id);
                }
            }

            if (!previewItems.length) {
                loading.dismiss();
                window.showToast?.('No related tracks found');
                return false;
            }

            await store.clearQueue();

            store.update({
                radioMode: {
                    seedVideoId: seed.videoId,
                    seedTitle: seed.title,
                    seedArtist: seed.artist,
                    activeVideoId: seed.videoId,
                    trackList: previewItems
                }
            });

            for (const item of previewItems) {
                await store.addPreviewToQueue(item);
            }

            audioEngine.setContext(previewItems);

            const firstTrack = await store.popNextFromQueue();
            if (firstTrack) {
                audioEngine.playTrack(firstTrack);
            }

            loading.dismiss();
            window.showToast?.(`Radio: ${seed.title}`);
            return true;
        } catch (err) {
            loading.dismiss();
            window.showToast?.('Could not start radio');
            console.error('Radio start error:', err);
            return false;
        }
    }

    /**
     * Refill the queue if running low. Uses the currently playing track as a new seed for variety.
     * @returns {Promise<boolean>} true if refilled successfully
     */
    async refillIfNeeded() {
        if (!store.state.radioMode) return false;
        if (this._refilling) return false;

        const queueLen = store.state.queue?.length || 0;
        if (queueLen > REFILL_THRESHOLD) return false;

        const currentTrack = store.state.currentTrack;
        if (!currentTrack) return false;

        const currentVideoId = currentTrack.id;
        if (!isYoutubeVideoId(currentVideoId)) return false;
        if (currentVideoId === store.state.radioMode.activeVideoId) {
            // Same seed — still try, but only if queue is empty
            if (queueLen > 0) return false;
        }

        this._refilling = true;
        try {
            const related = await fetchRelatedVideos(currentVideoId);
            if (!related.length) return false;

            const newItems = [];
            for (const row of related) {
                if (playedIds.has(row.id)) continue;
                const item = rowToPreviewItem(row);
                if (item) {
                    newItems.push(item);
                    playedIds.add(item.id);
                }
            }

            if (!newItems.length) return false;

            for (const item of newItems) {
                await store.addPreviewToQueue(item);
            }

            store.update({
                radioMode: {
                    ...store.state.radioMode,
                    activeVideoId: currentVideoId,
                    trackList: [...(store.state.radioMode.trackList || []), ...newItems]
                }
            });

            // Update context so sequential fallback also has the new tracks
            audioEngine.setContext(store.state.radioMode.trackList);

            return true;
        } catch (err) {
            console.error('Radio refill error:', err);
            return false;
        } finally {
            this._refilling = false;
        }
    }

    /**
     * Exit radio mode. Does not clear the queue.
     */
    exitRadio() {
        if (!store.state.radioMode) return;
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
