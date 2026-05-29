/**
 * Client debug logging — enable with ?debug=1 or localStorage.soundsible_debug=1
 */
let _cached = null;

export function isDebugEnabled() {
    if (_cached !== null) return _cached;
    if (typeof window === 'undefined') {
        _cached = false;
        return _cached;
    }
    try {
        if (new URLSearchParams(window.location.search).get('debug') === '1') {
            _cached = true;
            return _cached;
        }
        if (window.localStorage?.getItem('soundsible_debug') === '1') {
            _cached = true;
            return _cached;
        }
    } catch (_) {
        /* private mode / blocked storage */
    }
    _cached = false;
    return _cached;
}

export function debugLog(...args) {
    if (isDebugEnabled()) console.log(...args);
}

export function debugWarn(...args) {
    if (isDebugEnabled()) console.warn(...args);
}
