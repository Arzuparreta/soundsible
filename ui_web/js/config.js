/**
 * Frontend config: single source for Station API port and API base URL.
 * Change port here when the Station Engine runs on a different port.
 */
export const STATION_PORT = 5005;

function getRuntimeProtocol() {
    if (typeof window !== 'undefined' && window.location?.protocol) return window.location.protocol;
    return 'http:';
}

function getRuntimePort() {
    if (typeof window !== 'undefined' && window.location?.port) return window.location.port;
    return String(STATION_PORT);
}

/**
 * @param {string} host - Hostname (e.g. from store.state.activeHost or location.hostname)
 * @returns {string} Full API base URL, e.g. http://localhost:5005
 */
export function getApiBase(host) {
    const resolvedHost = host || (typeof window !== 'undefined' && window.location?.hostname) || 'localhost';
    return `${getRuntimeProtocol()}//${resolvedHost}:${getRuntimePort()}`;
}
