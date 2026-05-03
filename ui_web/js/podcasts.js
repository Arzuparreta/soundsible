/**
 * Podcasts UI — reliable core for playback, subscriptions, and show detail.
 * Two-level navigation: Podcast Home -> Show Detail.
 */
import { store } from './store.js';
import { getApiBase } from './config.js';
import { Resolver } from './resolver.js';
import { esc } from './renderers.js';
import { Haptics } from './haptics.js';
import { playPodcastPreview } from './preview_playback.js';
import {
    normalizeEpisode,
    findLibraryEpisode,
    resolveEpisodeForPlayback,
    getPodcastSubscriptions,
    getDownloadedEpisodes,
    fetchEpisodesForFeed,
    makeEpisodeId
} from './podcast_model.js';
import * as renderers from './renderers.js';

function apiBase() {
    return getApiBase(store.state.activeHost);
}

/** Card id → row from /api/discovery/podcasts/top (for subscribe / open detail). */
const _podcastTopRecByCardId = new Map();
let _podcastTopRecsRows = null;
/** @type {'idle' | 'loading' | 'ok' | 'error'} */
let _podcastTopRecsLoadState = 'idle';
let _podcastTopRecsErrorMsg = '';

function topPodcastCardId(row) {
    const cid = row && row.itunes_collection_id != null ? String(row.itunes_collection_id) : '';
    return cid ? `top_${cid}` : '';
}

/** Build CSS url() value for HTML style="…" attributes.
 *  Uses an unquoted url(…) with percent-encoding for all characters that
 *  could break CSS parsing — no quote-conflict risk whatsoever.
 */
function cssBgUrl(url) {
    if (!url) return '';
    // Percent-encode characters that could break unquoted CSS url()
    const safe = String(url)
        .replace(/\\/g, '%5C')
        .replace(/'/g, '%27')
        .replace(/"/g, '%22')
        .replace(/ /g, '%20')
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29')
        .replace(/,/g, '%2C')
        .replace(/#/g, '%23')
        .replace(/</g, '%3C')
        .replace(/>/g, '%3E');
    return `url(${safe})`;
}

/** Resolve a playable podcast episode and start playback. Works from any context. */
function playEpisodeById(episodeId) {
    const eps = window._currentPodcastEpisodes || [];
    const ep = eps.find((e) => e.id === episodeId);
    if (!ep) {
        // Fallback: try to find a downloaded episode in the library
        const lib = store.state.library || [];
        const libTrack = lib.find((t) => t.id === episodeId);
        if (libTrack && typeof window.playTrack === 'function') {
            window.playTrack(libTrack.id);
            return;
        }
        console.warn('[podcasts] Episode not found:', episodeId);
        if (typeof window.showToast === 'function') window.showToast('Episode not available');
        return;
    }
    const track = resolveEpisodeForPlayback(ep);
    if (track.source === 'library') {
        if (typeof window.playTrack === 'function') window.playTrack(track.id);
    } else if (!track.enclosure_url) {
        if (typeof window.showToast === 'function') window.showToast('No audio URL for this episode');
    } else {
        playPodcastPreview({
            enclosure_url: track.enclosure_url,
            title: track.title,
            artist: track.artist,
            duration: track.duration,
            thumbnail: track.thumbnail,
            podcast_feed_id: track.podcast_feed_id,
            podcast_episode_guid: track.podcast_episode_guid,
            podcast_rss_url: track.podcast_rss_url,
        });
    }
}

window.playPodcastEpisode = playEpisodeById;

function navigateToPodcastShowDetail() {
    if (typeof DesktopUI !== 'undefined' && DesktopUI.showView && document.getElementById('desktop-view-podcast-show-detail')) {
        DesktopUI.showView('podcast-show-detail');
        return;
    }
    if (typeof UI !== 'undefined' && UI.showView) UI.showView('podcast-show-detail');
}

export class PodcastsUI {
    static _selectors = null;
    static _desktopInit = false;
    static _mobileInit = false;
    /** @type {WeakSet<Element>} */
    static _subsClickBoundRoots = new WeakSet();

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
            downloadedList: mobile ? 'podcast-downloaded-list' : 'desktop-podcast-downloaded-list',
            recsGrid: mobile ? 'podcast-recs-grid' : 'desktop-podcast-recs-grid',
            showDetailRoot: mobile ? 'view-podcast-show-detail' : 'desktop-view-podcast-show-detail',
            showDetailTitle: mobile ? 'podcast-show-detail-title' : 'desktop-podcast-show-detail-title',
            showDetailMeta: mobile ? 'podcast-show-detail-meta' : 'desktop-podcast-show-detail-meta',
            showDetailCover: mobile ? 'podcast-show-detail-cover' : 'desktop-podcast-show-detail-cover',
            showDetailEpisodes: mobile ? 'podcast-show-detail-episodes' : 'desktop-podcast-show-detail-episodes',
            showDetailDownloadedOnly: mobile ? 'podcast-show-detail-downloaded-only' : 'desktop-podcast-show-detail-downloaded-only',
            showDetailSubscribeBtn: mobile ? 'podcast-show-detail-subscribe-btn' : 'desktop-podcast-show-detail-subscribe-btn',
        };

        const sel = this._selectors;
        const root = document.getElementById(sel.root);
        if (!root) return;

        if (!this._subsClickBoundRoots.has(root)) {
            this._subsClickBoundRoots.add(root);
            root.addEventListener('click', (e) => {
                const card = e.target.closest('[data-podcast-sub-card]');
                if (!card) return;
                const list = document.getElementById(sel.subsList);
                if (!list || !list.contains(card)) return;
                const fid = card.getAttribute('data-feed-id');
                if (fid) {
                    e.preventDefault();
                    e.stopPropagation();
                    PodcastsUI.openShowDetail(fid);
                }
            });
        }

        const searchBtn = document.getElementById(sel.searchBtn);
        const searchInput = document.getElementById(sel.searchInput);
        if (searchBtn) searchBtn.addEventListener('click', () => this.runSearch());
        if (searchInput) {
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this.runSearch();
            });
        }

        // Refresh subscriptions button on podcast home
        const refreshBtn = document.getElementById(mobile ? 'podcast-refresh-subs' : 'desktop-podcast-refresh-subs');
        if (refreshBtn) refreshBtn.addEventListener('click', () => this.refreshFromServer());

        // Show detail back button
        const backBtn = document.getElementById(mobile ? 'podcast-show-detail-back' : 'desktop-podcast-show-detail-back');
        if (backBtn) {
            backBtn.addEventListener('click', () => {
                if (mobile && typeof UI !== 'undefined' && UI.goToPreviousView) UI.goToPreviousView();
                if (!mobile && typeof DesktopUI !== 'undefined' && DesktopUI.navigateBack) DesktopUI.navigateBack();
            });
        }

        // Downloaded-only toggle in show detail
        const dlOnly = document.getElementById(sel.showDetailDownloadedOnly);
        if (dlOnly) dlOnly.addEventListener('change', () => this.renderShowDetailEpisodes());

        // Subscribe/unsubscribe button in show detail
        const subBtn = document.getElementById(sel.showDetailSubscribeBtn);
        if (subBtn) subBtn.addEventListener('click', () => this.toggleCurrentSubscription());

        // Subscribe to store changes — re-render podcast home when library/subscription state changes
        store.subscribe(() => this.renderHome());

        // Refresh subscriptions when entering the view
        const mo = new MutationObserver(() => {
            const el = document.getElementById(sel.root);
            if (el && (el.classList.contains('active') || !el.classList.contains('hidden'))) {
                this.renderHome();
            }
        });
        mo.observe(root, { attributes: true, attributeFilter: ['class'] });

        this.refreshFromServer();
    }

    static async refreshFromServer() {
        _podcastTopRecsRows = null;
        _podcastTopRecsLoadState = 'idle';
        _podcastTopRecByCardId.clear();
        _podcastTopRecsErrorMsg = '';
        try {
            const r = await fetch(`${apiBase()}/api/podcasts/subscriptions`);
            if (r.ok) {
                const d = await r.json();
                if (Array.isArray(d.subscriptions)) {
                    store.update({ podcastSubscriptions: d.subscriptions });
                }
            }
        } catch (_) {}
        this.renderHome();
    }

    static async _loadTopRecommendations() {
        if (_podcastTopRecsLoadState !== 'idle') return;
        _podcastTopRecsLoadState = 'loading';
        this.renderHome();
        try {
            const r = await fetch(`${apiBase()}/api/discovery/podcasts/top?limit=24`);
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.error || r.statusText || 'Failed to load recommendations');
            const results = Array.isArray(d.results) ? d.results : [];
            _podcastTopRecByCardId.clear();
            for (const row of results) {
                const cid = topPodcastCardId(row);
                if (cid) _podcastTopRecByCardId.set(cid, row);
            }
            _podcastTopRecsRows = results;
            _podcastTopRecsLoadState = 'ok';
            _podcastTopRecsErrorMsg = '';
        } catch (e) {
            _podcastTopRecsLoadState = 'error';
            _podcastTopRecsErrorMsg = String(e.message || e);
            _podcastTopRecsRows = null;
        }
        this.renderHome();
    }

    static renderHome() {
        const sel = this._selectors;
        const root = document.getElementById(sel.root);
        if (!root) return;
        // Only render if the root view is visible (avoid re-rendering hidden views)
        if (root.classList.contains('hidden')) return;

        const subs = getPodcastSubscriptions();
        const downloaded = getDownloadedEpisodes(store.state.library);

        // Render Your Shows
        const subsEl = document.getElementById(sel.subsList);
        if (subsEl) {
            if (!subs.length) {
                subsEl.innerHTML = `<p class="text-xs text-[var(--text-dim)] px-2">No subscriptions yet. Search or browse recommendations.</p>`;
            } else {
                subsEl.innerHTML = subs.map((s) => {
                    const safeId = esc(s.id);
                    const imgUrl = s.image_url || '';
                    return `
                    <div class="playlist-card group cursor-pointer rounded-[var(--radius-omni-xs)] border border-[var(--glass-border)] bg-[var(--bg-card)] overflow-hidden transition-colors duration-200 hover:border-[var(--accent)]/25"
                         data-podcast-sub-card="1" data-feed-id="${safeId}" role="button" tabindex="0">
                        <div class="playlist-card-cover aspect-square w-full relative overflow-hidden rounded-t-[var(--radius-omni-xs)] bg-[var(--bg-card)] border-b border-[var(--glass-border)]">
                            ${imgUrl
                                ? `<img class="absolute inset-0 w-full h-full object-cover" src="${esc(imgUrl)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="absolute inset-0 hidden items-center justify-center"><i class="fas fa-podcast text-3xl text-[var(--text-dim)]/40"></i></div>`
                                : '<div class="absolute inset-0 flex items-center justify-center"><i class="fas fa-podcast text-3xl text-[var(--text-dim)]/40"></i></div>'}
                        </div>
                        <div class="p-3">
                            <div class="playlist-card-name font-bold text-sm truncate text-[var(--text-main)] group-hover:text-[var(--accent)] transition-colors">${esc(s.title || 'Show')}</div>
                            <div class="text-[10px] font-mono text-[var(--text-dim)] truncate mt-0.5">${esc(s.author || '')}</div>
                        </div>
                    </div>`;
                }).join('');
            }
        }

        // Render Downloaded Episodes
        const dlEl = document.getElementById(sel.downloadedList);
        if (dlEl) {
            if (!downloaded.length) {
                dlEl.innerHTML = `<p class="text-xs text-[var(--text-dim)] px-2">No downloaded episodes.</p>`;
            } else {
                const options = {
                    activeTrackId: store.state.currentTrack?.id,
                    favIds: store.state.favorites || [],
                    desktopClickBehavior: !this._mobileInit && this._desktopInit,
                    getCoverUrl: (t) => (t.thumbnail || '').trim() || Resolver.getCoverUrl(t),
                };
                dlEl.innerHTML = renderers.buildSongRowsHtml(downloaded, options);
            }
        }

        // Discover / chart recommendations (Apple top podcasts via station)
        const recEl = document.getElementById(sel.recsGrid);
        if (recEl) {
            if (_podcastTopRecsRows === null && _podcastTopRecsLoadState === 'idle') {
                void this._loadTopRecommendations();
            }
            if (_podcastTopRecsLoadState === 'loading' && !_podcastTopRecsRows) {
                recEl.innerHTML = `<p class="text-xs text-[var(--text-dim)] px-2"><i class="fas fa-circle-notch fa-spin text-[var(--accent)] mr-2"></i>Loading recommendations…</p>`;
            } else if (_podcastTopRecsLoadState === 'error' && !_podcastTopRecsRows) {
                recEl.innerHTML = `<p class="text-xs text-[var(--text-dim)] px-2">${esc(_podcastTopRecsErrorMsg || 'Could not load recommendations.')} Use refresh to retry.</p>`;
            } else if (Array.isArray(_podcastTopRecsRows) && _podcastTopRecsRows.length === 0 && _podcastTopRecsLoadState === 'ok') {
                recEl.innerHTML = `<p class="text-xs text-[var(--text-dim)] px-2">No chart results right now. Try search above.</p>`;
            } else if (Array.isArray(_podcastTopRecsRows) && _podcastTopRecsRows.length) {
                recEl.innerHTML = _podcastTopRecsRows.map((rec) => {
                    const cardId = topPodcastCardId(rec);
                    if (!cardId) return '';
                    const isSubbed = subs.some((s) => s.rss_url === rec.feed_url);
                    const imgUrl = rec.image_url || '';
                    return `
                <div class="podcast-rec-card playlist-card group cursor-pointer rounded-[var(--radius-omni-xs)] border border-[var(--glass-border)] bg-[var(--bg-card)] overflow-hidden transition-colors duration-200 hover:border-[var(--accent)]/25"
                     data-rec-id="${esc(cardId)}">
                    <div class="playlist-card-cover aspect-square w-full relative overflow-hidden rounded-t-[var(--radius-omni-xs)] bg-[var(--bg-card)] border-b border-[var(--glass-border)]">
                        ${imgUrl
                            ? `<img class="absolute inset-0 w-full h-full object-cover" src="${esc(imgUrl)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div class="absolute inset-0 hidden items-center justify-center"><i class="fas fa-podcast text-3xl text-[var(--text-dim)]/40"></i></div>`
                            : '<div class="absolute inset-0 flex items-center justify-center"><i class="fas fa-podcast text-3xl text-[var(--text-dim)]/40"></i></div>'}
                    </div>
                    <div class="p-3">
                        <div class="playlist-card-name font-bold text-sm truncate text-[var(--text-main)] group-hover:text-[var(--accent)] transition-colors">${esc(rec.title)}</div>
                        <div class="text-[10px] font-mono text-[var(--text-dim)] truncate mt-0.5">${esc(rec.author || '')}</div>
                        ${isSubbed ? '<div class="mt-1 text-[10px] font-black uppercase tracking-wider text-[var(--accent)]">Subscribed</div>' : `
                        <button type="button" class="podcast-rec-subscribe-btn mt-2 w-full py-1.5 rounded-lg text-xs font-bold bg-[var(--accent)] text-black"
                            data-rss="${esc(rec.feed_url)}" data-title="${esc(rec.title)}" data-author="${esc(rec.author)}" data-img="${esc(rec.image_url || '')}" data-itunes="${esc(rec.itunes_collection_id || '')}">Subscribe</button>`}
                    </div>
                </div>`;
                }).join('');
                recEl.querySelectorAll('.podcast-rec-subscribe-btn').forEach((btn) => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.subscribeFromItunes({
                            rss_url: btn.getAttribute('data-rss'),
                            title: btn.getAttribute('data-title'),
                            author: btn.getAttribute('data-author'),
                            image_url: btn.getAttribute('data-img') || undefined,
                            itunes_collection_id: btn.getAttribute('data-itunes') || undefined,
                        });
                    });
                });
                recEl.querySelectorAll('.podcast-rec-card').forEach((card) => {
                    card.addEventListener('click', () => {
                        const recId = card.getAttribute('data-rec-id');
                        if (recId) this.handleRecCardClick(recId);
                    });
                });
            }
        }
    }

    static async runSearch() {
        const sel = this._selectors;
        const q = (document.getElementById(sel.searchInput)?.value || '').trim();
        const box = document.getElementById(sel.searchResults);
        if (!box) return;
        if (!q) {
            box.innerHTML = '';
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
            box.innerHTML = results.map((row) => {
                const imgUrl = row.image_url || '';
                return `
                <div class="flex items-center gap-3 p-3 rounded-lg bg-[var(--surface-overlay)] border border-[var(--glass-border)] mb-2">
                    <div class="w-14 h-14 rounded-md overflow-hidden bg-[var(--bg-card)] flex-shrink-0 relative">
                        ${imgUrl
                            ? `<img class="absolute inset-0 w-full h-full object-cover" src="${esc(imgUrl)}" alt="" loading="lazy" onerror="this.style.display='none'" />`
                            : '<div class="absolute inset-0 flex items-center justify-center"><i class="fas fa-podcast text-sm text-[var(--text-dim)]/40"></i></div>'}
                    </div>
                    <div class="min-w-0 flex-1">
                        <div class="font-bold text-sm text-[var(--text-main)] truncate">${esc(row.title)}</div>
                        <div class="text-xs text-[var(--text-dim)] truncate">${esc(row.author)}</div>
                    </div>
                    <button type="button" class="podcast-subscribe-btn px-3 py-1.5 rounded-lg text-xs font-bold bg-[var(--accent)] text-black"
                      data-feed="${esc(row.feed_url)}" data-title="${esc(row.title)}" data-author="${esc(row.author)}"
                      data-img="${esc(row.image_url || '')}" data-itunes="${esc(row.itunes_collection_id || '')}">Subscribe</button>
                </div>`;
            }).join('');
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

    static async subscribeFromItunes(meta, opts = {}) {
        const subs = getPodcastSubscriptions();
        const existing = subs.find((s) => s.rss_url === meta.rss_url);
        if (existing) {
            if (opts.openDetail) this.openShowDetail(existing.id);
            return;
        }

        const optId = `opt_${Date.now()}`;
        const optimisticSub = {
            id: optId,
            title: meta.title || 'Podcast',
            author: meta.author || '',
            rss_url: meta.rss_url,
            image_url: meta.image_url || '',
        };
        // Single store update — subscribers will call renderHome() automatically
        store.update({ podcastSubscriptions: [...subs, optimisticSub] });

        if (opts.openDetail) {
            this.openShowDetail(optId);
        }

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
            // Refresh from server replaces optimistic sub with real one
            await this.refreshFromServer();
            if (opts.openDetail) {
                const newSubs = getPodcastSubscriptions();
                const realSub = newSubs.find((s) => s.rss_url === meta.rss_url);
                if (realSub && this._currentFeedId === optId) {
                    // Re-open detail with real subscription ID
                    this._currentFeedId = realSub.id;
                    this._currentEpisodes = [];
                    const sel = this._selectors;
                    // Re-fetch episodes for real subscription
                    const { episodes } = await fetchEpisodesForFeed(realSub.id);
                    this._currentEpisodes = episodes;
                    window._currentPodcastEpisodes = episodes;
                    this.renderShowDetailEpisodes();
                }
            }
        } catch (e) {
            // Rollback optimistic subscription
            const currentSubs = getPodcastSubscriptions();
            store.update({ podcastSubscriptions: currentSubs.filter((s) => s.id !== optId) });
            Haptics.error();
            if (typeof window.showToast === 'function') window.showToast(String(e.message || e));
        }
    }

    static async unsubscribe(feedId) {
        try {
            const r = await fetch(`${apiBase()}/api/podcasts/subscriptions/${encodeURIComponent(feedId)}`, { method: 'DELETE' });
            if (!r.ok) throw new Error('Unsubscribe failed');
            Haptics.tick();
            if (typeof window.showToast === 'function') window.showToast('Unsubscribed');
            await this.refreshFromServer();
            // If currently in show detail for this feed, navigate back
            if (this._currentFeedId === feedId) {
                if (this._mobileInit && typeof UI !== 'undefined' && UI.goToPreviousView) UI.goToPreviousView();
                if (this._desktopInit && typeof DesktopUI !== 'undefined' && DesktopUI.navigateBack) DesktopUI.navigateBack();
            }
        } catch (e) {
            Haptics.error();
            if (typeof window.showToast === 'function') window.showToast(String(e.message || e));
        }
    }

    static _currentFeedId = null;
    static _currentSubscription = null;
    static _currentEpisodes = [];
    static _isFetchingEpisodes = false;

    static handleRecCardClick(recId) {
        const rec = _podcastTopRecByCardId.get(recId);
        if (!rec || !rec.feed_url) return;
        const subs = getPodcastSubscriptions();
        const existing = subs.find((s) => s.rss_url === rec.feed_url);
        if (existing) {
            this.openShowDetail(existing.id);
        } else {
            this.subscribeFromItunes({
                rss_url: rec.feed_url,
                title: rec.title,
                author: rec.author,
                image_url: rec.image_url,
                itunes_collection_id: rec.itunes_collection_id,
            }, { openDetail: true });
        }
    }

    static async openShowDetail(feedId) {
        this._currentFeedId = feedId;
        const subs = getPodcastSubscriptions();
        let subscription = subs.find((s) => s.id === feedId);

        // If not found locally, try to find by RSS URL (e.g. optimistic sub replaced by real one)
        if (!subscription) {
            const rec = _podcastTopRecByCardId.get(feedId);
            if (rec && rec.feed_url) {
                subscription = {
                    id: feedId,
                    title: rec.title,
                    author: rec.author,
                    rss_url: rec.feed_url,
                    image_url: rec.image_url,
                };
            }
        }
        if (!subscription) {
            if (typeof window.showToast === 'function') window.showToast('Podcast not found');
            return;
        }

        // Render hero immediately BEFORE navigating so the user sees content right away
        const sel = this._selectors;
        const titleEl = document.getElementById(sel.showDetailTitle);
        const metaEl = document.getElementById(sel.showDetailMeta);
        const coverEl = document.getElementById(sel.showDetailCover);
        const subBtn = document.getElementById(sel.showDetailSubscribeBtn);
        const epEl = document.getElementById(sel.showDetailEpisodes);

        if (titleEl) titleEl.textContent = subscription.title || 'Podcast';
        if (metaEl) metaEl.textContent = subscription.author || '';
        if (coverEl) {
            const url = (subscription.image_url || '').trim();
            // Use an <img> element for reliable rendering (no CSS quoting issues)
            if (url) {
                coverEl.innerHTML = `<img class="w-full h-full object-cover rounded-[var(--radius-omni-sm)]" src="${esc(url)}" alt="${esc(subscription.title || 'Podcast cover')}" onerror="this.style.display='none'" />`;
            } else {
                coverEl.innerHTML = '<div class="w-full h-full flex items-center justify-center"><i class="fas fa-podcast text-3xl text-[var(--text-dim)]/40"></i></div>';
            }
        }
        if (subBtn) {
            subBtn.textContent = 'Unsubscribe';
            subBtn.className = 'px-4 py-2 rounded-lg text-xs font-bold bg-[var(--surface-overlay)] text-[var(--text-main)] border border-[var(--glass-border)]';
        }

        // Optimistic subscriptions are still being processed on the server
        if (String(feedId).startsWith('opt_')) {
            if (epEl) {
                epEl.innerHTML = `<div class="flex items-center justify-center py-8 text-sm text-[var(--text-dim)]"><i class="fas fa-circle-notch fa-spin text-[var(--accent)] mr-2"></i>Subscribing…</div>`;
            }
            this._currentSubscription = subscription;
            this._currentEpisodes = [];
            window._currentPodcastEpisodes = [];
            navigateToPodcastShowDetail();
            return;
        }

        this._currentSubscription = subscription;

        // Show loading state
        this._isFetchingEpisodes = true;
        if (epEl) {
            epEl.innerHTML = `<div class="flex items-center justify-center py-8"><i class="fas fa-circle-notch fa-spin text-[var(--accent)] text-xl"></i></div>`;
        }

        navigateToPodcastShowDetail();

        // Fetch episodes in background
        const { episodes, error } = await fetchEpisodesForFeed(feedId);
        this._isFetchingEpisodes = false;
        if (error) {
            if (epEl) {
                epEl.innerHTML = `<p class="text-sm text-red-400 text-center py-4">${esc(error)}</p>`;
            }
            this._currentEpisodes = [];
            window._currentPodcastEpisodes = [];
            return;
        }
        this._currentEpisodes = episodes;
        window._currentPodcastEpisodes = episodes;
        this.renderShowDetailEpisodes();
    }

    static renderShowDetailEpisodes() {
        const sel = this._selectors;
        const epEl = document.getElementById(sel.showDetailEpisodes);
        if (!epEl) return;

        // Don't override loading spinner while fetch is in progress
        if (this._isFetchingEpisodes) return;

        let eps = this._currentEpisodes || [];
        const dlOnlyEl = document.getElementById(sel.showDetailDownloadedOnly);
        const onlyDl = dlOnlyEl?.checked;
        if (onlyDl) {
            eps = eps.filter((ep) => ep._libraryTrackId);
        }

        if (!eps.length) {
            epEl.innerHTML = `<p class="text-sm text-[var(--text-dim)] text-center py-4">${onlyDl ? 'No downloaded episodes.' : 'No episodes in feed.'}</p>`;
            return;
        }

        const options = {
            activeTrackId: store.state.currentTrack?.id,
            favIds: store.state.favorites || [],
            desktopClickBehavior: !this._mobileInit && this._desktopInit,
            suppressActionMenu: true, // Episodes use inline actions
            getCoverUrl: (t) => (t.thumbnail || '').trim() || Resolver.getCoverUrl(t),
        };
        epEl.innerHTML = renderers.buildSongRowsHtml(eps, options);

        // Wire inline action buttons after render
        epEl.querySelectorAll('.song-row').forEach((row) => {
            const id = row.getAttribute('data-id');
            const ep = eps.find((e) => e.id === id);
            if (!ep) return;

            const slot = row.querySelector('.song-row-actions-slot');
            if (slot) {
                slot.removeAttribute('aria-hidden');
                slot.innerHTML = `
                        <button type="button" class="podcast-ep-queue w-8 h-8 flex items-center justify-center rounded-full bg-[var(--surface-overlay)] text-[var(--text-dim)] hover:text-[var(--text-main)] transition-colors" title="Add to queue" aria-label="Add to queue">
                            <i class="fas fa-list-ul text-xs"></i>
                        </button>
                        ${ep._libraryTrackId ? '' : `
                        <button type="button" class="podcast-ep-download w-8 h-8 flex items-center justify-center rounded-full bg-[var(--surface-overlay)] text-[var(--accent)] hover:opacity-80 transition-colors" title="Download" aria-label="Download">
                            <i class="fas fa-cloud-download-alt text-xs"></i>
                        </button>`}
                    `;
                slot.querySelector('.podcast-ep-queue')?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.queueEpisode(ep);
                });
                slot.querySelector('.podcast-ep-download')?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.downloadEpisode(ep);
                });
            }

            // Override click to play episode — stop propagation so desktop click delegation doesn't interfere
            row.onclick = (e) => {
                if (e.target.closest('button')) return;
                e.stopPropagation();
                playEpisodeById(ep.id);
            };
        });
    }

    static toggleCurrentSubscription() {
        if (!this._currentFeedId) return;
        const subs = getPodcastSubscriptions();
        const isSubbed = subs.some((s) => s.id === this._currentFeedId);
        if (isSubbed) {
            this.unsubscribe(this._currentFeedId);
        } else {
            // Should not happen from detail, but handle gracefully
            this.subscribeFromItunes({ rss_url: this._currentSubscription?.rss_url });
        }
    }

    static async queueEpisode(ep) {
        try {
            if (ep._libraryTrackId) {
                const ok = await store.addToQueue(ep._libraryTrackId);
                if (ok && typeof window.showToast === 'function') window.showToast('Added to queue');
            } else {
                const ok = await store.addPreviewToQueue({
                    enclosure_url: ep.enclosure_url,
                    episode_id: ep.id,
                    title: ep.title,
                    artist: ep.artist,
                    duration: ep.duration,
                    thumbnail: ep.thumbnail,
                    podcast_feed_id: ep.podcast_feed_id,
                    podcast_episode_guid: ep.podcast_episode_guid,
                    podcast_rss_url: ep.podcast_rss_url,
                    album: ep.album,
                });
                if (ok && typeof window.showToast === 'function') window.showToast('Added to queue');
            }
            Haptics.tick();
        } catch (e) {
            Haptics.error();
            if (typeof window.showToast === 'function') window.showToast(String(e.message || e));
        }
    }

    static async downloadEpisode(ep) {
        const sub = this._currentSubscription || { id: ep.podcast_feed_id, title: ep.artist, rss_url: ep.podcast_rss_url, image_url: ep.thumbnail };
        const item = {
            source_type: 'podcast_enclosure',
            song_str: ep.enclosure_url,
            enclosure_url: ep.enclosure_url,
            feed_id: sub.id,
            podcast_feed_id: sub.id,
            episode_guid: ep.podcast_episode_guid,
            title: ep.title,
            podcast_title: ep.title,
            show_title: sub.title,
            podcast_show_title: sub.title,
            album: sub.title,
            podcast_album: sub.title,
            thumbnail_url: ep.thumbnail || sub.image_url || '',
            duration_sec: ep.duration || 0,
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

window.PodcastsUI = PodcastsUI;
