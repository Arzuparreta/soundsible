/**
 * Unified Search: Library + ODST in one bar.
 * 1s debounce, auto-show results; library instant, ODST async; merge and rank; source labels.
 * Link paste → add to download queue and clear input (only case we clear input).
 */
import { store } from './store.js';
import * as renderers from './renderers.js';
import { Resolver } from './resolver.js';
import { Haptics } from './haptics.js';

const DEBOUNCE_MS = 1000;

function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function escapeCssUrl(url) {
    if (!url) return '';
    return String(url).replace(/"/g, '%22').replace(/'/g, '%27');
}

let debounceTimer = null;
let odstAbortController = null;
let inputEl = null;
let resultsEl = null;
let lastLibraryItems = [];
let lastOdstResults = [];
let isMobile = true;
/** Search tab ODST source: 'music' = YouTube Music, 'youtube' = normal YouTube. */
let odstSourceMode = 'music';

function scoreLibrary(track, query) {
    const q = query.toLowerCase();
    const title = (track.title || '').toLowerCase();
    const artist = (track.artist || '').toLowerCase();
    const album = (track.album || '').toLowerCase();
    let score = 0;
    if (title.startsWith(q)) score += 100;
    else if (title.includes(q)) score += 50;
    if (artist.startsWith(q)) score += 80;
    else if (artist.includes(q)) score += 40;
    if (album.startsWith(q)) score += 60;
    else if (album.includes(q)) score += 30;
    return score;
}

function scoreOdst(item, query) {
    const q = query.toLowerCase();
    const title = (item.title || '').toLowerCase();
    const channel = (item.channel || '').toLowerCase();
    let score = 0;
    if (title.startsWith(q)) score += 100;
    else if (title.includes(q)) score += 50;
    if (channel.startsWith(q)) score += 80;
    else if (channel.includes(q)) score += 40;
    return score;
}

/** Same scoring idea as scoreLibrary: for artist name vs query. Used by Library mixed search. */
export function scoreArtist(artistName, query) {
    const q = (query || '').toLowerCase();
    const name = (artistName || '').toLowerCase();
    if (!q) return 0;
    if (name.startsWith(q)) return 80;
    if (name.includes(q)) return 40;
    return 0;
}

/** Shared comparator: score desc, then sortTitle asc. Same as Search tab merge order. */
export function mergeAndSortByScore(items) {
    return [...items].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (a.sortTitle || '').localeCompare(b.sortTitle || '');
    });
}

export { scoreLibrary };

function buildLibraryRowHtml(track) {
    const coverUrl = Resolver.getCoverUrl(track);
    const coverStyle = coverUrl ? `background-image: url(${escapeCssUrl(coverUrl)})` : '';
    const state = store.state;
    const isActive = state.currentTrack && state.currentTrack.id === track.id;
    const isFav = (state.favorites || []).includes(track.id);
    return `
    <div class="search-result-item mb-2">
        <div class="text-[9px] font-black uppercase tracking-widest text-[var(--text-dim)] mb-0.5">Library</div>
        <div class="song-row relative z-10 flex items-center p-3 ${isActive ? 'bg-[var(--bg-selection)] border-[var(--glass-border)]' : 'bg-[var(--bg-card)] border-transparent'} rounded-2xl border active:scale-[0.98] transition-all cursor-pointer" data-id="${esc(track.id)}" data-source="library">
            <div class="song-row-cover-wrapper relative w-12 h-12 flex-shrink-0">
                <div class="song-row-cover absolute inset-0 rounded-xl overflow-hidden bg-cover bg-center border border-[var(--glass-border)] shadow-lg" style="${coverStyle}" role="img" aria-label="Cover"></div>
            </div>
            <div class="ml-4 flex-1 truncate">
                <div class="song-title font-bold text-sm truncate text-[var(--text-main)]">${esc(track.title)}</div>
                <div class="text-[10px] text-[var(--text-dim)] font-bold truncate uppercase tracking-widest mt-0.5 font-mono">${esc(track.artist)}</div>
            </div>
            <div class="flex items-center ml-4">
                <div class="text-[9px] font-bold font-mono text-[var(--text-dim)] opacity-50 tracking-tighter">${renderers.formatTime(track.duration)}</div>
            </div>
        </div>
    </div>`;
}

function buildOdstRowHtml(r) {
    const thumbUrl = (r.thumbnail || '').replace(/"/g, '%22').replace(/'/g, '%27');
    const duration = renderers.formatTime(r.duration);
    return `
    <div class="search-result-item mb-2">
        <div class="text-[9px] font-black uppercase tracking-widest text-[var(--text-dim)] mb-0.5">ODST</div>
        <div class="flex items-center gap-3 p-3 rounded-xl border border-[var(--input-border)] transition-colors group cursor-pointer hover:bg-[var(--surface-overlay)]" style="background-color: var(--input-bg);" data-video-id="${esc(r.id)}" data-source="odst">
            <div class="w-12 h-12 rounded-lg flex-shrink-0 dl-result-thumb bg-cover bg-center" style="background-image:url('${thumbUrl}'); background-color: var(--input-bg);"></div>
            <div class="flex-1 min-w-0">
                <div class="text-sm font-bold truncate text-[var(--text-main)]">${esc(r.title)}</div>
                <div class="text-xs text-[var(--text-dim)] truncate">${esc(r.channel)} ${duration ? ' · ' + duration : ''}</div>
            </div>
            <button type="button" class="dl-add-one w-10 h-10 rounded-full bg-[var(--surface-overlay)] hover:bg-[var(--accent)] text-[var(--text-main)] flex items-center justify-center flex-shrink-0 opacity-100 transition-all" data-video-id="${esc(r.id)}" aria-label="Add to download queue"><i class="fas fa-plus text-sm"></i></button>
        </div>
    </div>`;
}

function render(merged) {
    if (!resultsEl) return;
    const list = Array.isArray(merged) ? merged : [];
    const libraryTracks = list.filter((m) => m.source === 'library').map((m) => m.track);
    if (typeof window.viewContext !== 'undefined') window.viewContext.searchTracks = libraryTracks;
    window._currentSearchTracks = libraryTracks;
    if (list.length === 0) {
        resultsEl.innerHTML = '<div class="text-center py-8 text-[var(--text-dim)]">No results</div>';
        return;
    }
    const html = list.map((item) => {
        if (item.source === 'library') return buildLibraryRowHtml(item.track);
        return buildOdstRowHtml(item);
    }).join('');
    resultsEl.innerHTML = html;
    bindListeners(list);
}

function bindListeners(merged) {
    if (!resultsEl) return;
    resultsEl.querySelectorAll('[data-source="library"]').forEach((row) => {
        const id = row.getAttribute('data-id');
        if (!id) return;
        row.addEventListener('click', (e) => {
            if (e.target.closest('.dl-add-one')) return;
            if (typeof window.playTrack === 'function') window.playTrack(id);
        });
    });
    const odstItems = merged.filter((m) => m.source === 'odst');
    resultsEl.querySelectorAll('[data-source="odst"]').forEach((row) => {
        const videoId = row.getAttribute('data-video-id');
        if (!videoId) return;
        const item = odstItems.find((o) => o.id === videoId) || null;
        row.addEventListener('click', (e) => {
            if (e.target.closest('.dl-add-one')) return;
            if (typeof window.Downloader !== 'undefined' && window.Downloader.playPreview) {
                window.Downloader.playPreview(videoId);
            }
        });
        const addBtn = row.querySelector('.dl-add-one');
        if (addBtn && item && typeof window.Downloader !== 'undefined' && window.Downloader.addToDownloadQueue) {
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                window.Downloader.addToDownloadQueue(item);
            });
        }
    });
}

/** Same engine as Library: shared filter, instant. Only updates library list; ODST is separate (debounced). */
function runLibraryOnly(raw) {
    if (!resultsEl) return;
    const libraryTracks = renderers.filterLibraryByQuery(store.state.library, raw);
    const libraryItems = libraryTracks.map((track) => ({
        source: 'library',
        track,
        score: scoreLibrary(track, raw),
        sortTitle: (track.title || '').toLowerCase()
    }));
    lastLibraryItems = libraryItems;
    const sorted = [...libraryItems].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (a.sortTitle || '').localeCompare(b.sortTitle || '');
    });
    render(sorted);
    const loading = resultsEl.querySelector('.search-odst-loading');
    if (loading) loading.remove();
    const loadingOdstEl = document.createElement('div');
    loadingOdstEl.className = 'search-odst-loading text-center py-4 text-[var(--text-dim)] text-sm';
    loadingOdstEl.textContent = 'Loading ODST results…';
    resultsEl.appendChild(loadingOdstEl);
}

/** Only ODST fetch; merges with lastLibraryItems when done. Called when 1s debounce fires. */
function runOdstFetch(raw) {
    if (!resultsEl || !raw) {
        const loading = resultsEl?.querySelector('.search-odst-loading');
        if (loading) loading.remove();
        return;
    }
    const Downloader = window.Downloader;
    if (Downloader && typeof Downloader.parseUrlLines === 'function') {
        const parsed = Downloader.parseUrlLines(raw);
        if (parsed.mode === 'url') {
            const loading = resultsEl.querySelector('.search-odst-loading');
            if (loading) loading.remove();
            return;
        }
    }
    const sourceParam = (odstSourceMode === 'youtube') ? 'youtube' : 'ytmusic';
    if (odstAbortController) odstAbortController.abort();
    odstAbortController = new AbortController();
    fetch(`${store.apiBase}/api/downloader/youtube/search?q=${encodeURIComponent(raw)}&limit=10&source=${sourceParam}`, {
        signal: odstAbortController.signal
    })
        .then((resp) => resp.json())
        .then((data) => {
            const results = data.results || [];
            lastOdstResults = results;
            const odstItems = results.map((r) => ({
                source: 'odst',
                ...r,
                score: scoreOdst(r, raw),
                sortTitle: (r.title || '').toLowerCase()
            }));
            const merged = [...lastLibraryItems, ...odstItems].sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                return (a.sortTitle || '').localeCompare(b.sortTitle || '');
            });
            render(merged);
        })
        .catch((err) => {
            if (err.name === 'AbortError') return;
            const sorted = [...lastLibraryItems].sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                return (a.sortTitle || '').localeCompare(b.sortTitle || '');
            });
            render(sorted);
            const loading = resultsEl?.querySelector('.search-odst-loading');
            if (loading) loading.remove();
            if (resultsEl) {
                const msg = document.createElement('div');
                msg.className = 'text-center py-2 text-red-400/80 text-sm';
                msg.textContent = 'ODST search unavailable';
                resultsEl.appendChild(msg);
            }
        });
}

function onDebounceFire() {
    debounceTimer = null;
    const raw = (inputEl && inputEl.value) ? inputEl.value.trim() : '';
    runOdstFetch(raw);
}

function onInput() {
    const raw = (inputEl && inputEl.value) ? inputEl.value.trim() : '';
    if (!resultsEl) return;
    if (!raw) {
        resultsEl.innerHTML = '<div class="text-center py-8 text-[var(--text-dim)]">Search library and ODST...</div>';
        lastLibraryItems = [];
        lastOdstResults = [];
        lastMergedFull = [];
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = null;
        return;
    }
    const Downloader = window.Downloader;
    if (Downloader && typeof Downloader.parseUrlLines === 'function') {
        const parsed = Downloader.parseUrlLines(raw);
        if (parsed.mode === 'url') {
            Downloader.enqueueDirectUrls(parsed.accepted.map((x) => x.normalized));
            if (inputEl) inputEl.value = '';
            if (typeof window.showToast === 'function') window.showToast('Link added to download queue');
            resultsEl.innerHTML = '<div class="text-center py-8 text-[var(--text-dim)]">Search library and ODST...</div>';
            lastLibraryItems = [];
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = null;
            return;
        }
    }
    runLibraryOnly(raw);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(onDebounceFire, DEBOUNCE_MS);
}

function onPaste() {
    setTimeout(() => {
        const raw = (inputEl && inputEl.value) ? inputEl.value.trim() : '';
        if (!raw) return;
        const Downloader = window.Downloader;
        if (Downloader && typeof Downloader.parseUrlLines === 'function') {
            const parsed = Downloader.parseUrlLines(raw);
            if (parsed.mode === 'url') {
                Downloader.enqueueDirectUrls(parsed.accepted.map((x) => x.normalized));
                if (inputEl) inputEl.value = '';
                if (typeof window.showToast === 'function') window.showToast('Link added to download queue');
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = null;
                if (resultsEl) resultsEl.innerHTML = '<div class="text-center py-8 text-[var(--text-dim)]">Search library and ODST...</div>';
            }
        }
    }, 0);
}

function clear() {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    if (odstAbortController) {
        odstAbortController.abort();
        odstAbortController = null;
    }
    if (resultsEl) resultsEl.innerHTML = '<div class="text-center py-8 text-[var(--text-dim)]">Search library and ODST...</div>';
    lastLibraryItems = [];
    lastOdstResults = [];
    if (typeof window.viewContext !== 'undefined') window.viewContext.searchTracks = null;
    window._currentSearchTracks = null;
}

function setSearchOdstSource(value) {
    if (value !== 'music' && value !== 'youtube') return;
    odstSourceMode = value;
    const musicBtn = document.getElementById('search-odst-music');
    const youtubeBtn = document.getElementById('search-odst-youtube');
    if (musicBtn && youtubeBtn) {
        if (value === 'music') {
            musicBtn.classList.add('bg-[var(--accent)]', 'text-[var(--text-on-accent)]');
            musicBtn.classList.remove('bg-[var(--accent)]/15', 'text-[var(--accent)]');
            musicBtn.setAttribute('aria-pressed', 'true');
            youtubeBtn.classList.remove('bg-[var(--accent)]', 'text-[var(--text-on-accent)]');
            youtubeBtn.classList.add('bg-[var(--accent)]/15', 'text-[var(--accent)]');
            youtubeBtn.setAttribute('aria-pressed', 'false');
        } else {
            youtubeBtn.classList.add('bg-[var(--accent)]', 'text-[var(--text-on-accent)]');
            youtubeBtn.classList.remove('bg-[var(--accent)]/15', 'text-[var(--accent)]');
            youtubeBtn.setAttribute('aria-pressed', 'true');
            musicBtn.classList.remove('bg-[var(--accent)]', 'text-[var(--text-on-accent)]');
            musicBtn.classList.add('bg-[var(--accent)]/15', 'text-[var(--accent)]');
            musicBtn.setAttribute('aria-pressed', 'false');
        }
    }
    Haptics.tick();
    const raw = (inputEl && inputEl.value) ? inputEl.value.trim() : '';
    if (raw) runOdstFetch(raw);
}

function init(opts = {}) {
    isMobile = opts.mobile !== false;
    const inputId = isMobile ? 'search-page-input' : 'desktop-search-page-input';
    const resultsId = isMobile ? 'search-page-results' : 'desktop-search-page-results';
    inputEl = document.getElementById(inputId);
    resultsEl = document.getElementById(resultsId);
    if (!inputEl || !resultsEl) return;

    clear();
    resultsEl.innerHTML = '<div class="text-center py-8 text-[var(--text-dim)]">Search library and ODST...</div>';

    const musicBtn = document.getElementById('search-odst-music');
    const youtubeBtn = document.getElementById('search-odst-youtube');
    if (musicBtn && youtubeBtn) {
        setSearchOdstSource(odstSourceMode);
        musicBtn.addEventListener('click', () => setSearchOdstSource('music'));
        youtubeBtn.addEventListener('click', () => setSearchOdstSource('youtube'));
    }

    inputEl.removeEventListener('input', onInput);
    inputEl.removeEventListener('paste', onPaste);
    inputEl.addEventListener('input', onInput);
    inputEl.addEventListener('paste', onPaste);

    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            inputEl.blur();
        }
    });
}

export const unifiedSearch = {
    init,
    clear
};
