/**
 * Phase 1 setup funnel: correlate telemetry via setup_session_id (docs/LAYER_CONTRACTS §3.1).
 */
import { getAdminHeaders } from './admin_auth.js';

const STORAGE_KEY = 'soundsible_setup_session_id_v1';

/** @returns {string|null} */
export function getSetupSessionId() {
    if (typeof sessionStorage === 'undefined') return null;
    let id = sessionStorage.getItem(STORAGE_KEY);
    if (!id && typeof crypto !== 'undefined' && crypto.randomUUID) {
        id = crypto.randomUUID();
        sessionStorage.setItem(STORAGE_KEY, id);
    }
    return id;
}

/**
 * Register session server-side (emits setup_session_started once per id). Safe to call often.
 * @param {string} apiBase
 */
export async function ensureSetupSessionStarted(apiBase) {
    const base = String(apiBase || '').trim();
    if (!base) return;
    const sid = getSetupSessionId();
    if (!sid) return;
    try {
        await fetch(`${base}/api/setup/session`, {
            method: 'POST',
            headers: getAdminHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ setup_session_id: sid }),
        });
    } catch (_) {
        /* ignore */
    }
}

let _firstPlayPosted = false;

/**
 * Idempotent client hint: first `playing` event for local/library track in this tab.
 * @param {string} apiBase
 * @param {string} [trackId]
 */
export function postSetupFirstPlayBeacon(apiBase, trackId) {
    if (_firstPlayPosted) return;
    const base = String(apiBase || '').trim();
    const sid = getSetupSessionId();
    if (!base || !sid) return;
    _firstPlayPosted = true;
    try {
        const body = { setup_session_id: sid };
        if (trackId) body.track_id = String(trackId);
        void fetch(`${base}/api/setup/first-play`, {
            method: 'POST',
            headers: getAdminHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(body),
        });
    } catch (_) {
        _firstPlayPosted = false;
    }
}
