/**
 * Frontend config: single source for Station API port and API base URL.
 * Change port here when the Station Engine runs on a different port.
 */
export const STATION_PORT = 5005;

function getRuntimeLocation() {
    if (typeof window !== 'undefined' && window.location) return window.location;
    return null;
}

/**
 * @param {string} host - Hostname (e.g. from store.state.activeHost or location.hostname)
 * @param {Location|object|null} runtimeLocation - Injectable browser location for tests.
 * @returns {string} Full API base URL, e.g. http://localhost:5005
 */
export function getApiBase(host, runtimeLocation = getRuntimeLocation()) {
    const currentHostname = runtimeLocation?.hostname || '';
    const resolvedHost = host || currentHostname || 'localhost';

    if (runtimeLocation?.origin && runtimeLocation.origin !== 'null' && resolvedHost === currentHostname) {
        return runtimeLocation.origin;
    }

    const protocol = runtimeLocation?.protocol || 'http:';
    const formattedHost = resolvedHost.includes(':') && !resolvedHost.startsWith('[')
        ? `[${resolvedHost}]`
        : resolvedHost;
    return `${protocol}//${formattedHost}:${STATION_PORT}`;
}
