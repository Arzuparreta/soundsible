/**
 * Client play-timing for library/static playback: intent → `playing`, with Phase 2 sub-segments.
 * POST /api/playback/play-timing (trusted LAN or scoped token).
 */
import { store } from './store.js';
import { getAdminHeaders } from './admin_auth.js';

let _intentTrackId = null;
let _intentAtMs = 0;
/** @type {{ srcSetAt: number|null, beforePlayAt: number|null, afterPlayAwait: number|null }|null} */
let _marks = null;

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
    _marks = { srcSetAt: null, beforePlayAt: null, afterPlayAwait: null };
}

function _now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** After `audio.src` + `load()` (library/static path). */
export function playTimingMarkSrcSet(trackId) {
    if (!_intentTrackId || !_marks || String(trackId) !== _intentTrackId) return;
    _marks.srcSetAt = _now();
}

/** Immediately before `await audio.play()`. */
export function playTimingMarkBeforePlay(trackId) {
    if (!_intentTrackId || !_marks || String(trackId) !== _intentTrackId) return;
    _marks.beforePlayAt = _now();
}

/** Immediately after `audio.play()` promise settles. */
export function playTimingMarkAfterPlayAwait(trackId) {
    if (!_intentTrackId || !_marks || String(trackId) !== _intentTrackId) return;
    _marks.afterPlayAwait = _now();
}

export function playTimingOnPlaying(track) {
    if (!_intentTrackId || !_intentAtMs) return;
    if (!track || String(track.id) !== _intentTrackId) return;
    if (!isPlayTimingEligibleTrack(track)) {
        _intentTrackId = null;
        _intentAtMs = 0;
        _marks = null;
        return;
    }
    const now = _now();
    const t0 = _intentAtMs;
    const segments = { intent_to_playing_ms: Math.max(0, Math.round(now - t0)) };
    const m = _marks;
    if (m?.srcSetAt != null) {
        segments.intent_to_src_set_ms = Math.max(0, Math.round(m.srcSetAt - t0));
        if (m.beforePlayAt != null) {
            segments.src_set_to_play_call_ms = Math.max(0, Math.round(m.beforePlayAt - m.srcSetAt));
        }
    }
    if (m?.beforePlayAt != null) {
        segments.intent_to_play_call_ms = Math.max(0, Math.round(m.beforePlayAt - t0));
        if (m.afterPlayAwait != null) {
            segments.play_call_to_await_ms = Math.max(0, Math.round(m.afterPlayAwait - m.beforePlayAt));
            segments.await_to_playing_ms = Math.max(0, Math.round(now - m.afterPlayAwait));
        }
    }
    _intentTrackId = null;
    _intentAtMs = 0;
    _marks = null;
    void postPlayTiming(track.id, segments);
}

function postPlayTiming(trackId, segments) {
    try {
        const body = JSON.stringify({
            track_id: trackId,
            device_id: store.getDeviceId(),
            phase: 'intent_to_playing',
            segments,
        });
        fetch(`${store.apiBase}/api/playback/play-timing`, {
            method: 'POST',
            headers: getAdminHeaders({ 'Content-Type': 'application/json' }),
            body,
        }).catch(() => {});
    } catch (_) {}
}
