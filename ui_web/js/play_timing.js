/**
 * Phase 1: measure user tap → first audio (`playing`) for local/static playback only.
 * POST /api/playback/play-timing (trusted LAN or scoped token).
 */
import { store } from './store.js';
import { getAdminHeaders } from './admin_auth.js';

let _intentTrackId = null;
let _intentAtMs = 0;

/** Library/static streams only — exclude previews, radio, Deezer rows. */
export function isPlayTimingEligibleTrack(track) {
    if (!track || track.id == null) return false;
    const id = String(track.id);
    if (id.startsWith('deezer_')) return false;
    const src = track.source;
    if (
        src === 'preview' ||
        src === 'radio' ||
        src === 'podcast-preview' ||
        src === 'preview-pending'
    ) {
        return false;
    }
    return true;
}

export function playTimingNoteUserIntent(trackId) {
    if (!trackId) return;
    _intentTrackId = String(trackId);
    _intentAtMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function playTimingOnPlaying(track) {
    if (!_intentTrackId || !_intentAtMs) return;
    if (!track || String(track.id) !== _intentTrackId) return;
    if (!isPlayTimingEligibleTrack(track)) {
        _intentTrackId = null;
        _intentAtMs = 0;
        return;
    }
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const delta = Math.max(0, Math.round(now - _intentAtMs));
    _intentTrackId = null;
    _intentAtMs = 0;
    void postPlayTiming(track.id, delta);
}

function postPlayTiming(trackId, intentToPlayingMs) {
    try {
        const body = JSON.stringify({
            track_id: trackId,
            device_id: store.getDeviceId(),
            phase: 'intent_to_playing',
            segments: { intent_to_playing_ms: intentToPlayingMs },
        });
        fetch(`${store.apiBase}/api/playback/play-timing`, {
            method: 'POST',
            headers: getAdminHeaders({ 'Content-Type': 'application/json' }),
            body,
        }).catch(() => {});
    } catch (_) {}
}
