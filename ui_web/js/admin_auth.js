const OWNER_TOKEN_STORAGE_KEY = 'soundsible_owner_token';
const OWNER_TOKEN_QUERY_PARAM = 'owner_token';

function _readLocalStorageToken() {
    try {
        return localStorage.getItem(OWNER_TOKEN_STORAGE_KEY) || '';
    } catch (_) {
        return '';
    }
}

function _writeLocalStorageToken(token) {
    try {
        if (!token) localStorage.removeItem(OWNER_TOKEN_STORAGE_KEY);
        else localStorage.setItem(OWNER_TOKEN_STORAGE_KEY, token);
    } catch (_) {}
}

function _readQueryToken() {
    if (typeof window === 'undefined' || !window.location?.search) return '';
    try {
        return new URLSearchParams(window.location.search).get(OWNER_TOKEN_QUERY_PARAM) || '';
    } catch (_) {
        return '';
    }
}

function _stripQueryToken() {
    if (typeof window === 'undefined' || !window.history?.replaceState || !window.location) return;
    try {
        const url = new URL(window.location.href);
        url.searchParams.delete(OWNER_TOKEN_QUERY_PARAM);
        window.history.replaceState({}, '', url.toString());
    } catch (_) {}
}

export function initializeOwnerTokenFromRuntime() {
    if (typeof window === 'undefined') return '';
    const queryToken = _readQueryToken().trim();
    if (queryToken) {
        _writeLocalStorageToken(queryToken);
        _stripQueryToken();
        return queryToken;
    }
    const globalToken = String(window.__SOUNDSIBLE_OWNER_TOKEN__ || '').trim();
    if (globalToken) {
        _writeLocalStorageToken(globalToken);
        return globalToken;
    }
    const metaToken = document.querySelector('meta[name="soundsible-owner-token"]')?.getAttribute('content') || '';
    if (metaToken.trim()) {
        _writeLocalStorageToken(metaToken.trim());
        return metaToken.trim();
    }
    return _readLocalStorageToken().trim();
}

export function getOwnerToken() {
    return initializeOwnerTokenFromRuntime();
}

export function hasOwnerToken() {
    return !!getOwnerToken();
}

export function getAdminHeaders(extraHeaders = {}) {
    const token = getOwnerToken();
    return token
        ? { ...extraHeaders, 'X-Soundsible-Admin-Token': token }
        : { ...extraHeaders };
}

export async function adminFetch(url, options = {}) {
    const headers = getAdminHeaders(options.headers || {});
    return fetch(url, { ...options, headers });
}
