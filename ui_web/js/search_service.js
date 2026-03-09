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
    // Legacy support during transition
    YTMUSIC_SEARCH: 'ytmusic_search',
    YOUTUBE_SEARCH_LEGACY: 'youtube_search'
};

const DEFAULT_DEBOUNCE_MS = 150;
const STORAGE_KEY_SOURCE_MODE = 'odst_source_mode';

class SearchService {
    constructor() {
        this.abortController = null;
        this.suggestAbortController = null;
        this.debounceTimer = null;
        this._sourceMode = localStorage.getItem(STORAGE_KEY_SOURCE_MODE) || 'music';
        this.suggestionDropdown = null;
        this.activeInput = null;
    }

    get sourceMode() {
        return this._sourceMode;
    }

    set sourceMode(value) {
        if (value !== 'music' && value !== 'youtube') return;
        this._sourceMode = value;
        localStorage.setItem(STORAGE_KEY_SOURCE_MODE, value);
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
     */
    attach(inputEl, onSelect = null) {
        if (!inputEl) return;
        this.activeInput = inputEl;
        
        const handleInput = async () => {
            const val = inputEl.value.trim();
            if (val.length < 2) {
                this.hideSuggestions();
                return;
            }
            const list = await this.suggest(val);
            if (list && list.length > 0) {
                this.renderSuggestions(list, onSelect);
            } else {
                this.hideSuggestions();
            }
        };

        inputEl.addEventListener('input', handleInput);
        inputEl.addEventListener('focus', handleInput);
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.hideSuggestions();
            if (e.key === 'Enter' && this.suggestionDropdown) {
                // If user hits enter and dropdown is visible, we could auto-select first one,
                // but usually the main search handles Enter. Let's just hide.
                this.hideSuggestions();
            }
        });

        // Hide on outside click
        document.addEventListener('click', (e) => {
            if (this.suggestionDropdown && !this.suggestionDropdown.contains(e.target) && e.target !== inputEl) {
                this.hideSuggestions();
            }
        });
    }

    renderSuggestions(list, onSelect) {
        if (!this.activeInput) return;
        if (!this.suggestionDropdown) {
            this.suggestionDropdown = document.createElement('div');
            this.suggestionDropdown.className = 'search-suggestions-dropdown absolute z-[1000] bg-[var(--bg-card)] border border-[var(--glass-border)] rounded-2xl shadow-2xl overflow-hidden mt-1 min-w-[200px] max-h-[300px] overflow-y-auto animate-in fade-in zoom-in-95 duration-100';
            document.body.appendChild(this.suggestionDropdown);
        }

        const rect = this.activeInput.getBoundingClientRect();
        this.suggestionDropdown.style.top = `${window.scrollY + rect.bottom}px`;
        this.suggestionDropdown.style.left = `${window.scrollX + rect.left}px`;
        this.suggestionDropdown.style.width = `${rect.width}px`;

        const html = list.map(item => `
            <div class="suggestion-item p-3 hover:bg-[var(--surface-overlay)] cursor-pointer text-sm font-medium transition-colors border-b border-[var(--glass-border)] last:border-0" data-value="${this.esc(item)}">
                <i class="fas fa-search text-[var(--text-dim)] mr-3 opacity-50"></i>
                ${this.esc(item)}
            </div>
        `).join('');

        this.suggestionDropdown.innerHTML = html;
        this.suggestionDropdown.classList.remove('hidden');

        this.suggestionDropdown.querySelectorAll('.suggestion-item').forEach(el => {
            el.addEventListener('click', (e) => {
                e.preventDefault();
                const val = el.getAttribute('data-value');
                this.activeInput.value = val;
                this.hideSuggestions();
                this.activeInput.dispatchEvent(new Event('input'));
                if (onSelect) onSelect(val);
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
            if (err.name === 'AbortError') return null; // Distinguish abort from real error
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

        const isMusic = this.sourceMode === 'music';
        
        const setActive = (btn) => {
            btn.classList.add('bg-[var(--accent)]', 'text-[var(--text-on-accent)]');
            btn.classList.remove('bg-[var(--accent)]/15', 'text-[var(--accent)]');
            btn.setAttribute('aria-pressed', 'true');
        };
        const setInactive = (btn) => {
            btn.classList.remove('bg-[var(--accent)]', 'text-[var(--text-on-accent)]');
            btn.classList.add('bg-[var(--accent)]/15', 'text-[var(--accent)]');
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
