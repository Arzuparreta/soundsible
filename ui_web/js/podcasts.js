/**
 * Podcasts: iTunes directory search, RSS subscriptions, episode download via Station queue.
 */
import { store } from './store.js';
import { getApiBase } from './config.js';
import { esc, formatTime } from './renderers.js';
import { Haptics } from './haptics.js';
import { playPodcastPreview } from './preview_playback.js';

function apiBase() {
    return getApiBase(store.state.activeHost);
}

function isEpisodeInLibrary(episodeGuid, feedId) {
    const lib = store.state.library || [];
    for (const t of lib) {
        if (
            (t.media_kind === 'podcast_episode' || t.genre === 'Podcast') &&
            String(t.podcast_feed_id || '') === String(feedId || '') &&
            String(t.podcast_episode_guid || '') === String(episodeGuid || '')
        ) {
            return t;
        }
    }
    return null;
}

export class PodcastsUI {
    static _selectors = null;
    static _desktopInit = false;
    static _mobileInit = false;

    /**
     * @param {{ mobile?: boolean }} opts
     */
    static init(opts = {}) {
        const mobile = !!opts.mobile;
        if (mobile) {
            if (this._mobileInit) return;
            this._mobileInit = true;
        } else {
            if (this._desktopInit) return;
            this._desktopInit = true;
        }
        this._selectors = {
            root: mobile ? 'view-podcast' : 'desktop-view-podcast',
            searchInput: mobile ? 'podcast-search-input' : 'desktop-podcast-search-input',
            searchBtn: mobile ? 'podcast-search-btn' : 'desktop-podcast-search-btn',
            searchResults: mobile ? 'podcast-search-results' : 'desktop-podcast-search-results',
            subsList: mobile ? 'podcast-subs-list' : 'desktop-podcast-subs-list',
            detailTitle: mobile ? 'podcast-detail-title' : 'desktop-podcast-detail-title',
            detailMeta: mobile ? 'podcast-detail-meta' : 'desktop-podcast-detail-meta',
            episodesList: mobile ? 'podcast-episodes-list' : 'desktop-podcast-episodes-list',
            refreshSubsBtn: mobile ? 'podcast-refresh-subs' : 'desktop-podcast-refresh-subs',
            downloadedOnly: mobile ? 'podcast-downloaded-only' : 'desktop-podcast-downloaded-only',
            addRssInput: mobile ? 'podcast-add-rss-input' : 'desktop-podcast-add-rss-input',
            addRssBtn: mobile ? 'podcast-add-rss-btn' : 'desktop-podcast-add-rss-btn'
        };

        const sel = this._selectors;
        const root = document.getElementById(sel.root);
        if (!root) return;

        const searchBtn = document.getElementById(sel.searchBtn);
        const searchInput = document.getElementById(sel.searchInput);
        if (searchBtn) searchBtn.addEventListener('click', () => this.runSearch());
        if (searchInput) {
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this.runSearch();
            });
        }
        const refreshBtn = document.getElementById(sel.refreshSubsBtn);
        if (refreshBtn) refreshBtn.addEventListener('click', () => this.refreshFromServer());
        const dlOnly = document.getElementById(sel.downloadedOnly);
        if (dlOnly) dlOnly.addEventListener('change', () => this.renderEpisodes());
        const addRssBtn = document.getElementById(sel.addRssBtn);
        const addRssInput = document.getElementById(sel.addRssInput);
        if (addRssBtn && addRssInput) {
            addRssBtn.addEventListener('click', () => this.subscribeByUrl());
        }

        store.subscribe(() => this.renderSubscriptions());
        const mo = new MutationObserver(() => {
            if (root.classList.contains('active') || root.classList.contains('flex')) {
                this.renderSubscriptions();
            }
        });
        mo.observe(root, { attributes: true, attributeFilter: ['class'] });

        store.syncLibrary().catch(() => {});
        this.renderSubscriptions();
    }

    static async refreshFromServer() {
        try {
            const r = await fetch(`${apiBase()}/api/podcasts/subscriptions`);
            if (r.ok) {
                const d = await r.json();
                if (Array.isArray(d.subscriptions)) {
                    store.update({ podcastSubscriptions: d.subscriptions });
                }
            }
        } catch (_) {}
        await store.syncLibrary();
        this.renderSubscriptions();
    }

    static async runSearch() {
        const sel = this._selectors;
        const q = (document.getElementById(sel.searchInput)?.value || '').trim();
        const box = document.getElementById(sel.searchResults);
        if (!box) return;
        if (!q) {
            box.innerHTML = '<p class="text-sm text-[var(--text-dim)]">Enter a search query.</p>';
            return;
        }
        box.innerHTML = '<p class="text-sm text-[var(--text-dim)]">Searching…</p>';
        try {
            const r = await fetch(`${apiBase()}/api/discovery/podcasts/search?q=${encodeURIComponent(q)}&limit=15`);
            const d = await r.json();
            const results = d.results || [];
            if (!results.length) {
                box.innerHTML = '<p class="text-sm text-[var(--text-dim)]">No podcasts found.</p>';
                return;
            }
            box.innerHTML = results
                .map((row) => {
                    const img = esc(row.image_url || '').replace(/'/g, "\\'");
                    return `
                <div class="flex items-center gap-3 p-3 rounded-lg bg-[var(--surface-overlay)] border border-[var(--glass-border)] mb-2">
                    <div class="w-14 h-14 rounded-md bg-cover bg-center flex-shrink-0" style="background-image:url('${img}')"></div>
                    <div class="min-w-0 flex-1">
                        <div class="font-bold text-sm text-[var(--text-main)] truncate">${esc(row.title)}</div>
                        <div class="text-xs text-[var(--text-dim)] truncate">${esc(row.author)}</div>
                    </div>
                    <button type="button" class="podcast-subscribe-btn px-3 py-1.5 rounded-lg text-xs font-bold bg-[var(--accent)] text-black"
                      data-feed="${esc(row.feed_url)}" data-title="${esc(row.title)}" data-author="${esc(row.author)}"
                      data-img="${esc(row.image_url || '')}" data-itunes="${esc(row.itunes_collection_id || '')}">Subscribe</button>
                </div>`;
                })
                .join('');
            box.querySelectorAll('.podcast-subscribe-btn').forEach((btn) => {
                btn.addEventListener('click', () => {
                    this.subscribeFromItunes({
                        rss_url: btn.getAttribute('data-feed'),
                        title: btn.getAttribute('data-title'),
                        author: btn.getAttribute('data-author'),
                        image_url: btn.getAttribute('data-img') || undefined,
                        itunes_collection_id: btn.getAttribute('data-itunes') || undefined
                    });
                });
            });
        } catch (e) {
            box.innerHTML = `<p class="text-sm text-red-400">${esc(String(e.message || e))}</p>`;
        }
    }

    static async subscribeFromItunes(meta) {
        try {
            const r = await fetch(`${apiBase()}/api/podcasts/subscribe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(meta)
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.error || r.statusText);
            Haptics.tick();
            if (typeof window.showToast === 'function') window.showToast('Subscribed');
            await store.syncLibrary();
            this.renderSubscriptions();
        } catch (e) {
            Haptics.error();
            if (typeof window.showToast === 'function') window.showToast(String(e.message || e));
        }
    }

    static async subscribeByUrl() {
        const sel = this._selectors;
        const inp = document.getElementById(sel.addRssInput);
        const url = (inp?.value || '').trim();
        if (!url) return;
        await this.subscribeFromItunes({ rss_url: url });
        if (inp) inp.value = '';
    }

    static renderSubscriptions() {
        const sel = this._selectors;
        const el = document.getElementById(sel.subsList);
        if (!el) return;
        const subs = store.state.podcastSubscriptions || [];
        if (!subs.length) {
            el.innerHTML = '<p class="text-xs text-[var(--text-dim)] px-2">No subscriptions yet. Search or paste an RSS URL.</p>';
            return;
        }
        el.innerHTML = subs
            .map((s) => {
                const img = esc(s.image_url || '').replace(/'/g, "\\'");
                return `
            <button type="button" class="w-full text-left podcast-sub-item flex items-center gap-2 p-2 rounded-lg hover:bg-[var(--surface-overlay)] border border-transparent hover:border-[var(--glass-border)]"
              data-id="${esc(s.id)}">
                <div class="w-10 h-10 rounded bg-cover bg-center flex-shrink-0" style="background-image:url('${img}')"></div>
                <div class="min-w-0 flex-1">
                    <div class="text-sm font-bold text-[var(--text-main)] truncate">${esc(s.title)}</div>
                    <div class="text-[10px] text-[var(--text-dim)] truncate">${esc(s.author || '')}</div>
                </div>
            </button>`;
            })
            .join('');
        el.querySelectorAll('.podcast-sub-item').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.getAttribute('data-id');
                const sub = subs.find((x) => x.id === id);
                if (sub) this.showSubscriptionDetail(sub);
            });
        });
    }

    static _currentSub = null;

    static async showSubscriptionDetail(sub) {
        this._currentSub = sub;
        const sel = this._selectors;
        const titleEl = document.getElementById(sel.detailTitle);
        const metaEl = document.getElementById(sel.detailMeta);
        const epEl = document.getElementById(sel.episodesList);
        if (titleEl) titleEl.textContent = sub.title || 'Podcast';
        if (metaEl) metaEl.textContent = sub.author || sub.rss_url || '';
        if (epEl) epEl.innerHTML = '<p class="text-sm text-[var(--text-dim)]">Loading episodes…</p>';

        try {
            const r = await fetch(`${apiBase()}/api/podcasts/feeds/${encodeURIComponent(sub.id)}/episodes`);
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || 'Failed to load episodes');
            window._podcastEpisodesCache = d.episodes || [];
            this.renderEpisodes();
        } catch (e) {
            if (epEl) epEl.innerHTML = `<p class="text-sm text-red-400">${esc(String(e.message || e))}</p>`;
        }
    }

    static renderEpisodes() {
        const sel = this._selectors;
        const epEl = document.getElementById(sel.episodesList);
        const sub = this._currentSub;
        if (!epEl || !sub) return;
        let eps = window._podcastEpisodesCache || [];
        const dlOnlyEl = document.getElementById(sel.downloadedOnly);
        const onlyDl = dlOnlyEl?.checked;
        if (onlyDl) {
            eps = eps.filter((ep) => isEpisodeInLibrary(ep.guid, sub.id));
        }
        if (!eps.length) {
            epEl.innerHTML =
                '<p class="text-sm text-[var(--text-dim)]">' +
                (onlyDl ? 'No downloaded episodes from this show.' : 'No episodes in feed.') +
                '</p>';
            return;
        }
        epEl.innerHTML = eps
            .map((ep) => {
                const dl = isEpisodeInLibrary(ep.guid, sub.id);
                const dur = formatTime(ep.duration_sec || 0);
                return `
            <div class="flex items-center gap-2 py-2 border-b border-[var(--glass-border)] podcast-ep-row" data-guid="${esc(ep.guid)}">
                <div class="min-w-0 flex-1">
                    <div class="text-sm text-[var(--text-main)]">${esc(ep.title)}</div>
                    <div class="text-[10px] text-[var(--text-dim)]">${esc(ep.published || '')} · ${dur}</div>
                </div>
                ${dl ? `<span class="text-[10px] font-bold text-[var(--accent)]">In library</span>
                    <button type="button" class="podcast-play-lib px-2 py-1 rounded text-xs bg-[var(--surface-overlay)]" data-track="${esc(dl.id)}">Play</button>` : `
                    <button type="button" class="podcast-preview-btn px-2 py-1 rounded text-xs bg-[var(--surface-overlay)]">Preview</button>
                    <button type="button" class="podcast-dl-btn px-2 py-1 rounded text-xs font-bold bg-[var(--accent)] text-black">Download</button>`}
            </div>`;
            })
            .join('');

        epEl.querySelectorAll('.podcast-ep-row').forEach((row) => {
            const guid = row.getAttribute('data-guid');
            const ep = eps.find((e) => String(e.guid) === String(guid));
            if (!ep) return;
            row.querySelector('.podcast-preview-btn')?.addEventListener('click', () => {
                this.previewEpisode(ep, sub);
            });
            row.querySelector('.podcast-dl-btn')?.addEventListener('click', () => {
                this.downloadEpisode(ep, sub);
            });
            row.querySelector('.podcast-play-lib')?.addEventListener('click', (ev) => {
                const tid = ev.currentTarget.getAttribute('data-track');
                if (tid && typeof window.playTrack === 'function') window.playTrack(tid);
            });
        });
    }

    static async previewEpisode(ep, sub) {
        await playPodcastPreview({
            enclosure_url: ep.enclosure_url,
            title: ep.title,
            artist: sub.title,
            duration: ep.duration_sec || 0,
            thumbnail: ep.image || sub.image_url || ''
        });
        Haptics.tick();
    }

    static async downloadEpisode(ep, sub) {
        const item = {
            source_type: 'podcast_enclosure',
            song_str: ep.enclosure_url,
            enclosure_url: ep.enclosure_url,
            feed_id: sub.id,
            podcast_feed_id: sub.id,
            episode_guid: ep.guid,
            title: ep.title,
            podcast_title: ep.title,
            show_title: sub.title,
            podcast_show_title: sub.title,
            album: sub.title,
            podcast_album: sub.title,
            thumbnail_url: ep.image || sub.image_url || '',
            duration_sec: ep.duration_sec || 0,
            podcast_rss_url: sub.rss_url || ''
        };
        try {
            const r = await fetch(`${apiBase()}/api/downloader/queue`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: [item] })
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) {
                const msg = d.rejected?.[0]?.reason || d.error || 'Queue failed';
                throw new Error(msg);
            }
            await fetch(`${apiBase()}/api/downloader/start`, { method: 'POST' });
            Haptics.tick();
            if (typeof window.showToast === 'function') window.showToast('Queued for download');
        } catch (e) {
            Haptics.error();
            if (typeof window.showToast === 'function') window.showToast(String(e.message || e));
        }
    }
}
