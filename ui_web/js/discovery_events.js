import { getApiBase } from './config.js';
import { adminFetch } from './admin_auth.js';

let settingsCache = null;
let settingsPromise = null;

function apiBase() {
    const host =
        (typeof window !== 'undefined' && window.location && window.location.hostname) ||
        'localhost';
    return getApiBase(host);
}

export async function getDiscoverySettings({ force = false } = {}) {
    if (!force && settingsCache) return settingsCache;
    if (!force && settingsPromise) return settingsPromise;
    settingsPromise = fetch(`${apiBase()}/api/discovery/settings`)
        .then((res) => res.json())
        .then((data) => {
            settingsCache = {
                v: data?.v || 1,
                learning_enabled: data?.learning_enabled !== false,
            };
            return settingsCache;
        })
        .catch(() => {
            settingsCache = { v: 1, learning_enabled: true };
            return settingsCache;
        })
        .finally(() => {
            settingsPromise = null;
        });
    return settingsPromise;
}

export async function setDiscoveryLearningEnabled(enabled) {
    const res = await adminFetch(`${apiBase()}/api/discovery/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ learning_enabled: !!enabled }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not update discovery settings');
    settingsCache = {
        v: data?.v || 1,
        learning_enabled: data?.learning_enabled !== false,
    };
    return settingsCache;
}

export function recordDiscoveryEvent(event, payload = {}) {
    if (!event || typeof window === 'undefined') return;
    void getDiscoverySettings().then((settings) => {
        if (settings?.learning_enabled === false) return;
        return fetch(`${apiBase()}/api/discovery/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event, payload }),
            keepalive: true,
        }).catch(() => {});
    });
}

export function initDiscoverySettingsToggle(inputId, statusId = null) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const status = statusId ? document.getElementById(statusId) : null;
    const setStatus = (text) => {
        if (status) status.textContent = text;
    };
    void getDiscoverySettings({ force: true }).then((settings) => {
        input.checked = settings.learning_enabled !== false;
        setStatus(input.checked ? 'Local learning is on.' : 'Local learning is off.');
    });
    input.addEventListener('change', async () => {
        input.disabled = true;
        try {
            const settings = await setDiscoveryLearningEnabled(input.checked);
            input.checked = settings.learning_enabled !== false;
            setStatus(input.checked ? 'Local learning is on.' : 'Local learning is off.');
        } catch (err) {
            input.checked = !input.checked;
            setStatus(err.message || 'Could not update local learning.');
        } finally {
            input.disabled = false;
        }
    });
}
