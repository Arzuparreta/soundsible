/**
 * Frontend config: single source for Station API port and API base URL.
 * Change port here when the Station Engine runs on a different port.
 */
export const STATION_PORT = 5005;

/**
 * @param {string} host - Hostname (e.g. from store.state.activeHost or location.hostname)
 * @returns {string} Full API base URL, e.g. http://localhost:5005
 */
export function getApiBase(host) {
    return `http://${host || 'localhost'}:${STATION_PORT}`;
}
