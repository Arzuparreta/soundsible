/**
 * SearchService: Centralized search and discovery logic for Soundsible.
 * Encapsulates API fetch, AbortController, debounce, source mode persistence,
 * and result normalization.
 */
import { store } from './store.js';
import { Haptics } from './haptics.js';

export const SourceType = {
    YOUTUBE_URL: 'youtube_url',
    YOUTUBE_SEARCH: 'youtube_search',
    YTMUSIC_SEARCH: 'ytmusic_search',
    // Note: Legacy support for older clients
    YTMUSIC_SEARCH_LEGACY: 'ytmusic_search',
    YOUTUBE_SEARCH_LEGACY: 'youtube_search'
};

const DEFAULT_DEBOUNCE_MS = 150;
const STORAGE_KEY_SOURCE_MODE = 'odst_source_mode';

class SearchService {
    constructor() {
        this.abortController = null;
        this.suggestAbortController = null;
        this.debounceTimer = null;
        // Note: Standardize 'ytmusic' is the default and canonical value
        const saved = localStorage.getItem(STORAGE_KEY_SOURCE_MODE);
        this._sourceMode = (saved === 'youtube') ? 'youtube' : 'ytmusic';
        this.suggestionDropdown = null;
        this.activeInput = null;
        this._typeaheadBindings = new WeakMap();
    }

    get sourceMode() {
        return this._sourceMode;
    }

    set sourceMode(value) {
        // Note: Normalize 'music' to 'ytmusic'
        const normalized = (value === 'music' || value === 'ytmusic') ? 'ytmusic' : 'youtube';
        this._sourceMode = normalized;
        localStorage.setItem(STORAGE_KEY_SOURCE_MODE, normalized);
    }

    /**
     * Fetches search suggestions from the backend.
     */
    async suggest(query) {
        const text = (query || '').trim();
        if (!text) return [];

        if (this.suggestAbortController) this.suggestAbortController.abort();
        this.suggestAbortController = new AbortController();

        try {
            const url = `${this.getApiBase()}/api/downloader/youtube/suggest?q=${encodeURIComponent(text)}`;
            const resp = await fetch(url, { signal: this.suggestAbortController.signal });
            if (!resp.ok) return [];
            const data = await resp.json();
            return data.suggestions || [];
        } catch (err) {
            if (err.name === 'AbortError') return null;
            return [];
        }
    }

    /**
     * Attaches typeahead behavior to an input element.
     * @param {HTMLElement} inputEl 
     * @param {Function} onSelect 
     * @param {Object} options { getLibraryMatches: Function }
     */
    attach(inputEl, onSelect = null, options = {}) {
        if (!inputEl) return () => {};
        const previousBinding = this._typeaheadBindings.get(inputEl);
        if (typeof previousBinding === 'function') previousBinding();

        const getLibraryMatches = options.getLibraryMatches || (() => []);
        const shouldSuggest = options.shouldSuggest || (() => true);
        let seq = 0;
        
        const handleInput = async () => {
            if (!shouldSuggest()) {
                if (this.activeInput === inputEl) this.hideSuggestions();
                return;
            }

            this.activeInput = inputEl;
            const val = inputEl.value.trim();
            if (val.length < 2) {
                this.hideSuggestions();
                return;
            }
            
            // Note: 1. Get global suggestions (async)
            const suggestPromise = this.suggest(val);
            // Note: 2. Get local library matches (sync)
            const libMatches = getLibraryMatches(val) || [];
            
            const currentSeq = ++seq;
            const list = await suggestPromise;
            if (currentSeq !== seq) return;
            if (document.activeElement !== inputEl) return;
            
            // ## Section: Format and merge
            const formattedLib = libMatches.slice(0, 5).map(m => ({ 
                type: 'library', 
                value: m.title || m, 
                sub: m.artist || '', 
                id: m.id,
                icon: 'fa-music'
            }));
            const formattedGlobal = (list || []).slice(0, 10).map(item => ({ 
                type: 'global', 
                value: item, 
                icon: 'fa-search' 
            }));

            const combined = [...formattedLib, ...formattedGlobal];

            if (combined.length > 0) {
                this.renderSuggestions(combined, onSelect, inputEl);
            } else {
                this.hideSuggestions();
            }
        };

        const handleFocus = () => {
            if (!shouldSuggest()) return;
            this.activeInput = inputEl;
            handleInput();
        };

        const handleKeydown = (e) => {
            if (e.key === 'Escape') this.hideSuggestions();
            if (e.key === 'Enter' && this.suggestionDropdown) {
                // Note: If user hits enter and dropdown is visible, we could auto-select first one,
                // Note: But usually the main search handles enter. let's just hide.
                this.hideSuggestions();
            }
        };

        const handleDocumentClick = (e) => {
            if (this.suggestionDropdown && !this.suggestionDropdown.contains(e.target) && e.target !== inputEl) {
                this.hideSuggestions();
            }
        };

        inputEl.addEventListener('input', handleInput);
        inputEl.addEventListener('focus', handleFocus);
        inputEl.addEventListener('keydown', handleKeydown);
        document.addEventListener('click', handleDocumentClick);

        const dispose = () => {
            inputEl.removeEventListener('input', handleInput);
            inputEl.removeEventListener('focus', handleFocus);
            inputEl.removeEventListener('keydown', handleKeydown);
            document.removeEventListener('click', handleDocumentClick);
            if (this.activeInput === inputEl) {
                this.hideSuggestions();
                this.activeInput = null;
            }
            if (this._typeaheadBindings.get(inputEl) === dispose) {
                this._typeaheadBindings.delete(inputEl);
            }
        };

        this._typeaheadBindings.set(inputEl, dispose);
        return dispose;
    }

    renderSuggestions(list, onSelect, anchorInput = this.activeInput) {
        if (!anchorInput) return;
        this.activeInput = anchorInput;
        if (!this.suggestionDropdown) {
            this.suggestionDropdown = document.createElement('div');
            this.suggestionDropdown.className = 'search-suggestions-dropdown absolute z-[1000] bg-[var(--bg-card)] border border-[var(--glass-border)] rounded-2xl shadow-2xl overflow-hidden mt-2 min-w-[280px] max-h-[400px] overflow-y-auto animate-in fade-in zoom-in-95 duration-100 backdrop-blur-xl';
            document.body.appendChild(this.suggestionDropdown);
        }

        const rect = anchorInput.getBoundingClientRect();
        this.suggestionDropdown.style.top = `${window.scrollY + rect.bottom}px`;
        this.suggestionDropdown.style.left = `${window.scrollX + rect.left}px`;
        this.suggestionDropdown.style.width = `${Math.max(rect.width, 320)}px`;

        const html = list.map(item => {
            const isLib = item.type === 'library';
            const icon = isLib ? 'fa-music' : 'fa-search';
            const subLabel = item.sub ? `<span class="text-[10px] text-[var(--text-dim)] uppercase tracking-wider ml-auto font-mono opacity-60">${this.esc(item.sub)}</span>` : '';
            const tag = isLib ? '<span class="px-1.5 py-0.5 rounded-md bg-[var(--accent)]/15 text-[var(--accent)] text-[8px] font-black uppercase tracking-widest mr-2">Library</span>' : '';
            
            return `
                <div class="suggestion-item p-3.5 hover:bg-[var(--surface-overlay)] cursor-pointer flex items-center transition-all duration-200 border-b border-[var(--glass-border)]/50 last:border-0" 
                     data-value="${this.esc(item.value)}" data-type="${item.type}" data-id="${item.id || ''}">
                    <div class="w-8 h-8 rounded-lg bg-[var(--bg-card)] border border-[var(--glass-border)] flex items-center justify-center mr-3 shrink-0 shadow-sm">
                        <i class="fas ${icon} text-[12px] opacity-70"></i>
                    </div>
                    <div class="flex-1 truncate flex items-center min-w-0">
                        <div class="flex flex-col min-w-0">
                            <span class="text-sm font-semibold truncate text-[var(--text-main)]">${tag}${this.esc(item.value)}</span>
                        </div>
                        ${subLabel}
                    </div>
                </div>
            `;
        }).join('');

        this.suggestionDropdown.innerHTML = html;
        this.suggestionDropdown.classList.remove('hidden');

        this.suggestionDropdown.querySelectorAll('.suggestion-item').forEach(el => {
            el.addEventListener('click', (e) => {
                e.preventDefault();
                const val = el.getAttribute('data-value');
                const type = el.getAttribute('data-type');
                const id = el.getAttribute('data-id');

                if (type === 'library' && id && typeof window.playTrack === 'function') {
                    window.playTrack(id);
                    this.hideSuggestions();
                    anchorInput.value = '';
                } else {
                    anchorInput.value = val;
                    this.hideSuggestions();
                    anchorInput.dispatchEvent(new Event('input'));
                    if (onSelect) onSelect(val);
                }
            });
        });
    }

    hideSuggestions() {
        if (this.suggestionDropdown) {
            this.suggestionDropdown.classList.add('hidden');
        }
    }

    getApiBase() {
        if (store && store.apiBase && store.state && store.state.activeHost) return store.apiBase;
        if (typeof window !== 'undefined' && window.location && window.location.origin) return window.location.origin;
        return '';
    }

    esc(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    normalizeYouTubeUrl(url) {
        try {
            const raw = (url || "").trim();
            if (!raw) return null;
            const parsed = new URL(raw);
            const host = parsed.hostname.toLowerCase();
            const isYoutubeHost = host.includes("youtube.com") || host.includes("youtu.be");
            if (!isYoutubeHost) return null;
            let videoId = "";
            if (host.includes("youtu.be")) {
                videoId = parsed.pathname.replace("/", "").trim();
            } else {
                videoId = parsed.searchParams.get("v") || "";
            }
            if (!videoId) return null;
            return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
        } catch {
            return null;
        }
    }

    parseUrlLines(rawInput) {
        const raw = (rawInput || "").trim();
        const lines = raw
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        if (lines.length === 0) return { mode: 'empty', accepted: [], rejected: [] };
        const urlMatches = raw.match(/https?:\/\/[^\s]+/g) || [];
        const textWithoutUrls = raw.replace(/https?:\/\/[^\s]+/g, '').trim();
        const candidates = urlMatches.length > 0 && textWithoutUrls.length === 0 ? urlMatches : lines;
        const accepted = [];
        const rejected = [];
        for (const line of candidates) {
            const normalized = this.normalizeYouTubeUrl(line);
            if (!normalized) {
                rejected.push({ line, reason: 'Unsupported or invalid URL' });
                continue;
            }
            accepted.push({ line, normalized });
        }
        const isUrlMode = accepted.length > 0 && rejected.length === 0;
        return { mode: isUrlMode ? 'url' : 'search', accepted, rejected, lines };
    }

    /**
     * Executes a search query with debounce and abort support.
     * @param {string} query - The search text.
     * @param {Object} options - { debounce, limit, source }
     * @returns {Promise<Array>} Normalized results.
     */
    async query(query, options = {}) {
        const text = (query || '').trim();
        if (!text) return [];

        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        
        const debounceMs = options.debounce !== undefined ? options.debounce : DEFAULT_DEBOUNCE_MS;
        
        if (debounceMs > 0) {
            return new Promise((resolve, reject) => {
                this.debounceTimer = setTimeout(async () => {
                    try {
                        const results = await this._performFetch(text, options);
                        resolve(results);
                    } catch (err) {
                        reject(err);
                    }
                }, debounceMs);
            });
        } else {
            return this._performFetch(text, options);
        }
    }

    async _performFetch(query, options = {}) {
        if (this.abortController) this.abortController.abort();
        this.abortController = new AbortController();

        const limit = options.limit || 10;
        const source = options.source || this.sourceMode;
        // Note: Sourcemode is already standardized to 'ytmusic' or 'youtube'
        const sourceParam = (source === 'youtube') ? 'youtube' : 'ytmusic';
        const url = `${this.getApiBase()}/api/downloader/youtube/search?q=${encodeURIComponent(query)}&limit=${limit}&source=${sourceParam}`;

        try {
            const resp = await fetch(url, { signal: this.abortController.signal });
            if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                throw new Error(data.error || (resp.status === 500 ? 'Server error' : `HTTP ${resp.status}`));
            }
            const data = await resp.json();
            return (data.results || []).map(r => this.normalizeResult(r));
        } catch (err) {
            if (err.name === 'AbortError') return null; // Note: Distinguish abort from real error
            throw err;
        }
    }

    normalizeResult(r) {
        return {
            id: r.id,
            title: r.title || 'Unknown Title',
            channel: r.channel || r.artist || 'Unknown Channel',
            duration: r.duration || 0,
            thumbnail: r.thumbnail || '',
            webpage_url: r.webpage_url || (r.id ? `https://www.youtube.com/watch?v=${r.id}` : '')
        };
    }

    applyToggleUI(musicBtnId, youtubeBtnId) {
        const musicBtn = document.getElementById(musicBtnId);
        const youtubeBtn = document.getElementById(youtubeBtnId);
        if (!musicBtn || !youtubeBtn) return;

        // Note: Use the canonical 'ytmusic' value for the comparison
        const isMusic = this.sourceMode === 'ytmusic';
        
        const setActive = (btn) => {
            btn.setAttribute('aria-pressed', 'true');
        };
        const setInactive = (btn) => {
            btn.setAttribute('aria-pressed', 'false');
        };

        if (isMusic) {
            setActive(musicBtn);
            setInactive(youtubeBtn);
        } else {
            setActive(youtubeBtn);
            setInactive(musicBtn);
        }
    }
}

export const searchService = new SearchService();
