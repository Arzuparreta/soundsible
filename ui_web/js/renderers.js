/**
 * Shared renderers: container-agnostic render functions for song lists, queue, artists.
 * Used by both mobile (app.js) and desktop (app_desktop.js).
 */
import { store } from './store.js';
import { Resolver } from './resolver.js';

/** Escape HTML to prevent XSS. */
export function esc(str) {
    if (!str) return "";
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

export function formatTime(seconds) {
    if (seconds == null || isNaN(Number(seconds))) return '0:00';
    const n = Number(seconds);
    const m = Math.floor(n / 60);
    const s = Math.floor(n % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Escape URL for use in CSS background-image url(). */
function escapeCssUrl(url) {
    if (!url) return '';
    return String(url).replace(/"/g, '%22').replace(/'/g, '%27');
}

export function sortLibraryTracks(tracks, order, favorites) {
    if (!tracks.length) return tracks;
    const favoritesSet = new Set(favorites || []);
    const alphaCmp = (a, b) => {
        const tc = (a.title || '').toLowerCase().localeCompare((b.title || '').toLowerCase());
        if (tc !== 0) return tc;
        return (a.artist || '').toLowerCase().localeCompare((b.artist || '').toLowerCase());
    };
    if (order === 'date_added') {
        return [...tracks].reverse();
    }
    if (order === 'favorites_first') {
        const fav = (favorites || []).map(id => tracks.find(t => t.id === id)).filter(Boolean);
        const rest = tracks.filter(t => !favoritesSet.has(t.id));
        return [...fav, ...rest];
    }
    if (order === 'alphabetical') {
        return [...tracks].sort(alphaCmp);
    }
    return [...tracks];
}

/** Split "A, B", "A feat. B" etc. into trimmed unique names. */
export function parseArtistNames(artistString) {
    if (!artistString || typeof artistString !== 'string') return [];
    const raw = artistString.trim();
    if (!raw) return [];
    const parts = raw.split(/\s*,\s*|\s+feat\.?\s+|\s+ft\.?\s+|\s+and\s+|\s+&\s+|\s+\+\s+|\s+x\s+/i)
        .map(s => s.trim())
        .filter(Boolean);
    return [...new Set(parts)];
}

export function normalizeArtistName(name) {
    return (name || '').trim().toLowerCase();
}

export function getArtistTracks(artistName, library) {
    return (library || []).filter(t => {
        const names = parseArtistNames(t.album_artist || t.artist);
        return names.includes(artistName);
    });
}

export function getArtistAlbums(artistName, library) {
    const tracks = getArtistTracks(artistName, library);
    const byAlbum = {};
    tracks.forEach(t => {
        const album = t.album || 'Unknown Album';
        if (!byAlbum[album]) byAlbum[album] = { tracks: [], coverTrack: t };
        byAlbum[album].tracks.push(t);
        if (t.track_number != null && (byAlbum[album].coverTrack.track_number == null || t.track_number < byAlbum[album].coverTrack.track_number)) {
            byAlbum[album].coverTrack = t;
        }
    });
    return Object.entries(byAlbum)
        .map(([album, { tracks: albumTracks, coverTrack }]) => ({
            album,
            tracks: albumTracks.sort((a, b) => (a.track_number ?? 999) - (b.track_number ?? 999)),
            coverTrack
        }))
        .sort((a, b) => a.album.localeCompare(b.album));
}

/**
 * Build HTML for song rows. Uses div + background-image for covers (no img) per project rule.
 * @param {Array} tracks
 * @param {Object} options - { activeTrackId, favIds, getCoverUrl, addDataIndex } (addDataIndex adds data-index for drag reorder)
 */
export function buildSongRowsHtml(tracks, options = {}) {
    const state = store.state;
    const activeId = options.activeTrackId ?? (state.currentTrack ? state.currentTrack.id : null);
    const favIds = options.favIds ?? (state.favorites || []);
    const getCoverUrl = options.getCoverUrl || Resolver.getCoverUrl.bind(Resolver);

    return tracks.map((t, idx) => {
        const isActive = t.id === activeId;
        const isFav = favIds.includes(t.id);
        const coverUrl = getCoverUrl(t);
        const coverStyle = coverUrl ? `background-image: url(${escapeCssUrl(coverUrl)})` : '';
        const dataIndexAttr = options.addDataIndex ? ` data-index="${idx}"` : '';
        const wrapperClass = options.addDataIndex ? ' playlist-detail-row' : '';
        return `
            <div class="relative overflow-hidden rounded-2xl mb-2 group bg-[var(--bg-card)]${wrapperClass}"${dataIndexAttr}>
                <div class="swipe-hints absolute inset-0 flex items-center justify-between px-8 z-0 pointer-events-none">
                    <div class="text-[var(--secondary)] font-black text-[9px] uppercase tracking-[0.2em]">Queue</div>
                    <div class="text-[var(--accent)] font-black text-[9px] uppercase tracking-[0.2em]">Favourite</div>
                </div>
                <div class="song-row relative z-10 flex items-center p-3 ${isActive ? 'bg-[var(--bg-selection)] border-[var(--glass-border)]' : 'bg-[var(--bg-card)] border-transparent'} rounded-2xl border active:scale-[0.98] transition-all cursor-pointer" data-id="${t.id}" onclick="typeof playTrack==='function'&&playTrack('${t.id}')">
                    <div class="song-row-cover-wrapper relative w-12 h-12 flex-shrink-0">
                        <div class="song-row-cover absolute inset-0 rounded-xl overflow-hidden bg-cover bg-center border border-[var(--glass-border)] shadow-lg" style="${coverStyle}" role="img" aria-label="Cover">
                            <div class="active-indicator-container absolute inset-0 flex items-center justify-center bg-[var(--accent)]/10 rounded-xl backdrop-blur-[1.6px] transition-all duration-150 ease-out pointer-events-none ${isActive ? 'opacity-100 is-playing' : 'opacity-0'}">
                                <i class="playing-icon fas fa-volume-high text-[var(--accent)] text-[14.4px]"></i>
                            </div>
                        </div>
                        <div class="fav-indicator absolute -top-1 -right-1 w-3.5 h-3.5 bg-[var(--accent)] rounded-full border-2 border-[var(--bg-card)] shadow-lg z-10 ${isFav ? '' : 'hidden'}"></div>
                    </div>
                    <div class="ml-4 flex-1 truncate">
                        <div class="song-title font-bold text-sm truncate ${isActive ? 'text-[var(--text-on-selection)]' : 'text-[var(--text-main)]'}">${esc(t.title)}</div>
                        <div class="text-[10px] text-[var(--text-dim)] font-bold truncate uppercase tracking-widest mt-0.5 font-mono">${esc(t.artist)}</div>
                    </div>
                    <div class="flex items-center space-x-3 ml-4">
                        <div class="no-row-action text-[9px] font-bold font-mono text-[var(--text-dim)] opacity-50 tracking-tighter">${formatTime(t.duration)}</div>
                        <button onclick="event.stopPropagation(); typeof UI!=='undefined'&&UI.showActionMenu&&UI.showActionMenu('${t.id}')" class="w-10 h-10 flex items-center justify-center text-[var(--text-dim)] active:text-[var(--text-main)] transition-colors rounded-full active:bg-[var(--surface-overlay)] focus:outline-none">
                            <i class="fas fa-ellipsis-v text-xs"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Build HTML for song grid cards (desktop). Same options as buildSongRowsHtml.
 * @param {Array} tracks
 * @param {Object} options - { activeTrackId, favIds, getCoverUrl }
 * @param {'grid'|'gridCompact'} gridSize - larger or smaller cards
 */
export function buildSongGridHtml(tracks, options = {}, gridSize = 'grid') {
    const state = store.state;
    const activeId = options.activeTrackId ?? (state.currentTrack ? state.currentTrack.id : null);
    const favIds = options.favIds ?? (state.favorites || []);
    const getCoverUrl = options.getCoverUrl || Resolver.getCoverUrl.bind(Resolver);
    const isCompact = gridSize === 'gridCompact';

    return tracks.map(t => {
        const isActive = t.id === activeId;
        const isFav = favIds.includes(t.id);
        const coverUrl = getCoverUrl(t);
        const coverStyle = coverUrl ? `background-image: url(${escapeCssUrl(coverUrl)})` : '';
        const cardClass = isCompact ? 'song-card song-card-compact' : 'song-card';
        return `
        <div class="${cardClass} group cursor-pointer rounded-2xl border border-[var(--glass-border)] bg-[var(--bg-card)] overflow-hidden transition-all duration-300 hover:border-[var(--accent)]/30 active:scale-[0.98]" data-id="${t.id}" onclick="typeof playTrack==='function'&&playTrack('${t.id}')">
            <div class="song-card-cover-wrapper relative aspect-square w-full">
                <div class="song-card-cover absolute inset-0 overflow-hidden bg-cover bg-center border-b border-[var(--glass-border)]" style="${coverStyle}" role="img" aria-label="Cover">
                    <div class="active-indicator-container absolute inset-0 flex items-center justify-center bg-[var(--accent)]/10 backdrop-blur-[1.6px] transition-all duration-150 ease-out pointer-events-none ${isActive ? 'opacity-100 is-playing' : 'opacity-0'}">
                        <i class="playing-icon fas fa-volume-high text-[var(--accent)] ${isCompact ? 'text-xs' : 'text-sm'}"></i>
                    </div>
                </div>
                <div class="fav-indicator absolute top-1 right-1 w-3 h-3 bg-[var(--accent)] rounded-full border-2 border-[var(--bg-card)] z-10 ${isFav ? '' : 'hidden'}"></div>
                <button onclick="event.stopPropagation(); typeof UI!=='undefined'&&UI.showActionMenu&&UI.showActionMenu('${t.id}')" class="absolute bottom-1 right-1 w-8 h-8 flex items-center justify-center rounded-full bg-black/50 text-white/90 opacity-0 group-hover:opacity-100 transition-opacity focus:outline-none z-10">
                    <i class="fas fa-ellipsis-v text-[10px]"></i>
                </button>
            </div>
            <div class="song-card-body p-2 min-w-0">
                <div class="song-card-title font-bold truncate ${isCompact ? 'text-xs' : 'text-sm'} ${isActive ? 'text-[var(--accent)]' : 'text-[var(--text-main)]'}">${esc(t.title)}</div>
                <div class="song-card-artist overflow-hidden whitespace-nowrap text-[10px] font-bold text-[var(--text-dim)] uppercase tracking-widest mt-0.5 font-mono" title="${esc(t.artist)}">
                    <span class="song-card-artist-text inline-block">${esc(t.artist || '')}</span>
                </div>
            </div>
        </div>
        `;
    }).join('');
}

/**
 * Enable marquee animation on artist labels that overflow. Call after grid render.
 * @param {HTMLElement|null} containerEl - element containing .song-card-artist nodes
 */
export function enableMarqueeIfNeeded(containerEl) {
    if (!containerEl) return;
    containerEl.querySelectorAll('.song-card-artist').forEach((wrapper) => {
        const span = wrapper.querySelector('.song-card-artist-text');
        if (!span) return;
        wrapper.classList.remove('artist-marquee');
        wrapper.style.removeProperty('--marquee-offset');
        if (span.scrollWidth > wrapper.clientWidth) {
            const offset = -(span.scrollWidth - wrapper.clientWidth);
            wrapper.style.setProperty('--marquee-offset', `${offset}px`);
            wrapper.classList.add('artist-marquee');
        }
    });
}

/**
 * @param {HTMLElement|null} containerEl
 * @param {Object} options - passed to buildSongRowsHtml
 */
export function renderSongList(tracks, containerEl, options = {}) {
    if (!containerEl) return;
    if (tracks.length === 0) {
        containerEl.innerHTML = '<div class="text-gray-500 text-center py-10 italic">No songs found.</div>';
        return;
    }
    containerEl.innerHTML = buildSongRowsHtml(tracks, options);
}

/**
 * Render queue into one or more container elements. Scroll cue (mobile) is handled by caller if needed.
 * @param {Object} state - store.state
 * @param {HTMLElement|HTMLElement[]} queueContainerEls - container(s) to fill; single element or array
 * @param {Object} options - { getCoverUrl, onPlayId, onRemoveFromQueue } (onRemoveFromQueue receives index)
 */
export function renderQueue(state, queueContainerEls, options = {}) {
    const containers = (Array.isArray(queueContainerEls) ? queueContainerEls : [queueContainerEls]).filter(c => c);
    if (containers.length === 0) return;

    const getCoverUrl = options.getCoverUrl || Resolver.getCoverUrl.bind(Resolver);

    if (!state.queue || state.queue.length === 0) {
        containers.forEach(c => c.innerHTML = '<div class="text-gray-500 text-center py-10 italic text-xs">Queue is empty.</div>');
        return;
    }

    const html = state.queue.map((t, idx) => {
        const coverUrl = getCoverUrl(t);
        const coverStyle = coverUrl ? `background-image: url(${escapeCssUrl(coverUrl)})` : '';
        return `
        <div class="queue-item flex items-center p-2 hover:bg-[var(--surface-overlay)] rounded-2xl transition-colors group" data-index="${idx}" data-id="${t.id}">
            <div class="queue-item-cover w-10 h-10 flex-shrink-0 rounded-xl overflow-hidden bg-cover bg-center border border-[var(--glass-border)] shadow-lg" style="${coverStyle}" role="img" aria-label=""></div>
            <div class="ml-3 flex-1 truncate pointer-events-none">
                <div class="font-bold text-[13px] truncate text-[var(--text-main)]">${esc(t.title)}</div>
                <div class="text-[10px] text-[var(--text-dim)] truncate uppercase tracking-widest">${esc(t.artist)}</div>
            </div>
            <div class="flex items-center space-x-2">
                <button onclick="typeof playTrack==='function'&&playTrack('${t.id}')" class="w-10 h-10 flex items-center justify-center bg-blue-500/10 text-blue-400 rounded-full hover:bg-blue-500/20 active:scale-90 transition-all">
                    <i class="fas fa-play text-xs"></i>
                </button>
                <button onclick="typeof store!==\"undefined\"&&store.removeFromQueue&&store.removeFromQueue(${idx})" class="w-10 h-10 flex items-center justify-center bg-[var(--surface-overlay)] text-[var(--text-dim)] rounded-full hover:bg-red-500/10 hover:text-red-400 active:scale-90 transition-all">
                    <i class="fas fa-times text-xs"></i>
                </button>
            </div>
        </div>
    `;
    }).join('');

    containers.forEach(c => { c.innerHTML = html; });
}

/**
 * @param {Object} state - store.state (for favorites list and query from searchInputEl)
 * @param {HTMLElement|null} searchInputEl - optional; if present, filter by its value
 * @param {HTMLElement|null} tracksContainerEl
 * @param {Object} options - passed to renderSongList
 */
export function renderFavourites(state, searchInputEl, tracksContainerEl, options = {}) {
    if (!tracksContainerEl) return;
    const fullFavTracks = (state.favorites || []).map(id => state.library.find(t => t.id === id)).filter(t => t);
    const query = searchInputEl ? searchInputEl.value.trim().toLowerCase() : '';
    const favTracks = !query
        ? fullFavTracks
        : fullFavTracks.filter(t =>
            t.title.toLowerCase().includes(query) ||
            t.artist.toLowerCase().includes(query) ||
            t.album.toLowerCase().includes(query)
        );
    renderSongList(favTracks, tracksContainerEl, options);
}

/**
 * @param {Array} library - full library
 * @param {HTMLElement|null} containerEl
 * @param {Object} options - { activeTrackId, isPlaying, getCoverUrl, onArtistClick } (onArtistClick(artistName))
 */
export function renderArtistList(library, containerEl, options = {}) {
    if (!containerEl) return;

    const byArtist = {};
    (library || []).forEach(t => {
        const raw = t.album_artist || t.artist;
        const names = parseArtistNames(raw);
        names.forEach(name => {
            if (!byArtist[name]) byArtist[name] = { track: t, count: 0 };
            byArtist[name].count += 1;
            if (t.id < byArtist[name].track.id) byArtist[name].track = t;
        });
    });
    const artistNames = Object.keys(byArtist).sort((a, b) => a.localeCompare(b));

    const currentTrack = options.currentTrack ?? store.state.currentTrack;
    const isPlaying = options.isPlaying ?? store.state.isPlaying;
    const currentTrackArtistsSet = new Set(
        (currentTrack && isPlaying ? parseArtistNames(currentTrack.album_artist || currentTrack.artist) : []).map(n => normalizeArtistName(n))
    );
    const getCoverUrl = options.getCoverUrl || Resolver.getCoverUrl.bind(Resolver);

    if (artistNames.length === 0) {
        containerEl.innerHTML = `
            <div class="col-span-full flex flex-col items-center justify-center py-16 text-center">
                <i class="fas fa-user-music text-4xl text-[var(--text-dim)]/50 mb-4"></i>
                <p class="text-[var(--text-dim)] font-bold text-sm uppercase tracking-widest">No artists in library</p>
            </div>
        `;
        return;
    }

    const artistHtml = artistNames.map(name => {
        const { track: t, count } = byArtist[name];
        const trackLabel = count === 1 ? '1 track' : `${count} tracks`;
        const safeName = (name || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const isCurrentlyPlaying = currentTrackArtistsSet.has(normalizeArtistName(name));
        const coverUrl = getCoverUrl(t);
        const coverStyle = coverUrl ? `background-image: url(${escapeCssUrl(coverUrl)})` : '';
        return `
        <div class="artist-card group cursor-pointer" data-artist-name="${esc(name)}" onclick="typeof showArtistDetail==='function'&&showArtistDetail('${safeName}')">
            <div class="artist-card-cover aspect-square w-full relative overflow-hidden rounded-[32px] shadow-2xl transition-all ease-[cubic-bezier(0.19,1,0.22,1)] group-hover:scale-105 active:scale-95 border border-[var(--glass-border)] bg-[var(--bg-card)] bg-cover bg-center" style="${coverStyle}; transition-duration: 500ms;" role="img" aria-label="${esc(name)}">
                <div class="artist-card-overlay absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                <div class="active-indicator-container absolute inset-0 flex items-center justify-center bg-[var(--accent)]/10 rounded-[32px] backdrop-blur-[1.6px] transition-all duration-150 ease-out pointer-events-none ${isCurrentlyPlaying ? 'opacity-100 is-playing' : 'opacity-0'}">
                    <i class="playing-icon fas fa-volume-high text-[var(--accent)] text-[14.4px]"></i>
                </div>
            </div>
            <div class="mt-4 px-2">
                <div class="artist-card-name font-bold text-sm truncate text-[var(--text-main)] group-hover:text-[var(--accent)] transition-colors">${esc(name)}</div>
                <div class="text-[10px] font-mono text-[var(--text-dim)] truncate mt-0.5">${esc(trackLabel)}</div>
            </div>
        </div>
    `;
    }).join('');

    containerEl.innerHTML = artistHtml;
}

/**
 * @param {string} artistName
 * @param {Array} library
 * @param {Object} heroElements - { titleEl, coverEl } (optional; coverEl can be img or div with background)
 * @param {HTMLElement|null} tracksEl
 * @param {HTMLElement|null} albumsEl
 * @param {Object} options - passed to buildSongRowsHtml
 */
export function renderArtistDetail(artistName, library, heroElements, tracksEl, albumsEl, options = {}) {
    const tracks = getArtistTracks(artistName, library);
    const { titleEl, coverEl } = heroElements || {};

    if (titleEl) titleEl.textContent = artistName;
    if (coverEl) {
        const firstTrack = tracks[0];
        if (firstTrack) {
            const url = (options.getCoverUrl || Resolver.getCoverUrl.bind(Resolver))(firstTrack);
            if (coverEl.tagName === 'IMG') {
                coverEl.src = url;
                coverEl.alt = artistName;
                coverEl.classList.remove('hidden');
            } else {
                coverEl.style.backgroundImage = url ? `url(${escapeCssUrl(url)})` : '';
                coverEl.classList.remove('hidden');
            }
        } else {
            coverEl.classList.add('hidden');
        }
    }

    if (albumsEl) {
        const albums = getArtistAlbums(artistName, library);
        if (albums.length === 0) {
            albumsEl.innerHTML = '<div class="col-span-full text-[var(--text-dim)] text-center py-8 text-sm">No albums</div>';
        } else {
            const getCoverUrl = options.getCoverUrl || Resolver.getCoverUrl.bind(Resolver);
            albumsEl.innerHTML = albums.map(({ album, tracks: albumTracks, coverTrack }) => {
                const trackLabel = albumTracks.length === 1 ? '1 track' : `${albumTracks.length} tracks`;
                const coverUrl = getCoverUrl(coverTrack);
                const coverStyle = coverUrl ? `background-image: url(${escapeCssUrl(coverUrl)})` : '';
                return `
                    <div class="artist-album-card flex flex-col" data-album="${esc(album)}">
                        <div class="artist-album-header cursor-pointer group rounded-2xl border border-[var(--glass-border)] bg-[var(--bg-card)] hover:border-[var(--accent)]/30 transition-colors active:scale-[0.98]" onclick="typeof toggleArtistAlbum==='function'&&toggleArtistAlbum(event)">
                            <div class="relative">
                                <div class="w-full aspect-square rounded-t-2xl border-b border-white/5 bg-cover bg-center" style="${coverStyle}" role="img" aria-label="${esc(album)}"></div>
                                <div class="absolute bottom-2 right-2 w-6 h-6 rounded-full bg-black/60 flex items-center justify-center">
                                    <i class="fas fa-chevron-down text-[10px] text-white transition-transform artist-album-chevron"></i>
                                </div>
                            </div>
                            <div class="p-3">
                                <div class="font-bold text-sm truncate text-[var(--text-main)] group-hover:text-[var(--accent)] transition-colors">${esc(album)}</div>
                                <div class="text-[10px] font-mono text-[var(--text-dim)] truncate mt-0.5">${esc(trackLabel)}</div>
                            </div>
                        </div>
                        <div class="artist-album-tracks mt-2 hidden overflow-hidden">
                            ${buildSongRowsHtml(albumTracks, options)}
                        </div>
                    </div>
                `;
            }).join('');
        }
    }

    if (tracksEl) {
        if (tracks.length === 0) {
            tracksEl.innerHTML = '<div class="text-[var(--text-dim)] text-center py-10 italic text-sm">No tracks</div>';
        } else {
            const sorted = [...tracks].sort((a, b) => {
                const albumCmp = (a.album || '').localeCompare(b.album || '');
                if (albumCmp !== 0) return albumCmp;
                return (a.track_number ?? 999) - (b.track_number ?? 999);
            });
            tracksEl.innerHTML = buildSongRowsHtml(sorted, options);
        }
    }
}

/**
 * Build HTML for playlist list cards. Uses div + background-image for cover (no img). Playlists is { name: track_ids[] }.
 * @param {Object} playlists - name -> array of track ids
 * @param {Array} library - full track list
 * @param {Object} options - { getCoverUrl, onCreateClick } (onCreateClick is optional handler name for "Create playlist" button)
 */
export function buildPlaylistCardsHtml(playlists, library, options = {}) {
    const getCoverUrl = options.getCoverUrl || Resolver.getCoverUrl.bind(Resolver);
    const names = options.preserveOrder ? Object.keys(playlists || {}) : Object.keys(playlists || {}).sort((a, b) => a.localeCompare(b));
    if (names.length === 0) {
        return '';
    }
    return names.map((name, idx) => {
        const trackIds = playlists[name] || [];
        const firstTrack = trackIds.length ? (library || []).find((t) => t.id === trackIds[0]) : null;
        const coverUrl = firstTrack ? getCoverUrl(firstTrack) : '';
        const coverStyle = coverUrl ? `background-image: url(${escapeCssUrl(coverUrl)})` : '';
        const count = trackIds.length;
        const label = count === 1 ? '1 track' : `${count} tracks`;
        const safeName = (name || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
        return `
        <div class="playlist-card group cursor-pointer rounded-2xl border border-[var(--glass-border)] bg-[var(--bg-card)] overflow-hidden transition-all duration-300 hover:border-[var(--accent)]/30 active:scale-[0.98]" data-playlist-name="${esc(name)}" data-index="${idx}" onclick="typeof showPlaylistDetail==='function'&&showPlaylistDetail('${safeName}')">
            <div class="playlist-card-cover aspect-square w-full relative overflow-hidden rounded-t-2xl bg-[var(--bg-card)] bg-cover bg-center border-b border-[var(--glass-border)]" style="${coverStyle}; min-height: 120px;" role="img" aria-label="${esc(name)}">
                ${!coverUrl ? '<div class="absolute inset-0 flex items-center justify-center"><i class="fas fa-layer-group text-3xl text-[var(--text-dim)]/40"></i></div>' : ''}
            </div>
            <div class="p-3">
                <div class="playlist-card-name font-bold text-sm truncate text-[var(--text-main)] group-hover:text-[var(--accent)] transition-colors">${esc(name)}</div>
                <div class="text-[10px] font-mono text-[var(--text-dim)] truncate mt-0.5">${esc(label)}</div>
            </div>
        </div>
        `;
    }).join('');
}

/**
 * Render playlist list into container. Shows grid of cards or empty state.
 * @param {Object} playlists - name -> track_ids[] (can be filtered)
 * @param {Array} library
 * @param {HTMLElement|null} listContainerEl - container for cards
 * @param {Object} options - { getCoverUrl, emptyMessage } (emptyMessage when filtered and no results)
 */
export function renderPlaylistList(playlists, library, listContainerEl, options = {}) {
    if (!listContainerEl) return;
    const names = options.preserveOrder ? Object.keys(playlists || {}) : Object.keys(playlists || {}).sort((a, b) => a.localeCompare(b));
    const html = buildPlaylistCardsHtml(playlists, library, { ...options, preserveOrder: options.preserveOrder });
    if (!html) {
        const msg = options.emptyMessage || 'No playlists yet. Create one or add tracks from Library.';
        listContainerEl.innerHTML = `
            <div class="flex flex-col items-center justify-center py-16 text-center">
                <i class="fas fa-layer-group text-4xl text-[var(--text-dim)]/50 mb-4"></i>
                <p class="text-[var(--text-dim)] font-bold text-sm uppercase tracking-widest mb-2">${options.emptyMessage ? 'No matches' : 'No playlists yet'}</p>
                <p class="text-[var(--text-dim)] text-xs mb-6">${esc(msg)}</p>
                ${!options.emptyMessage ? '<button type="button" class="create-playlist-btn px-6 py-3 rounded-xl bg-[var(--accent)] text-[var(--text-on-accent)] font-bold text-sm transition-all active:scale-95" onclick="typeof createPlaylistPrompt===\'function\'&&createPlaylistPrompt()"><i class="fas fa-plus mr-2"></i>Create playlist</button>' : ''}
            </div>
        `;
        return;
    }
    listContainerEl.innerHTML = html;
}

/**
 * Build HTML for track rows inside a playlist (play + remove from playlist). Uses div + background-image for cover (no img).
 * @param {Array} tracks
 * @param {Object} options - { playlistName, activeTrackId, getCoverUrl }
 */
export function buildPlaylistTrackRowsHtml(tracks, options = {}) {
    const state = store.state;
    const activeId = options.activeTrackId ?? (state.currentTrack ? state.currentTrack.id : null);
    const getCoverUrl = options.getCoverUrl || Resolver.getCoverUrl.bind(Resolver);
    const playlistName = options.playlistName || '';
    const safeName = (playlistName || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    return tracks.map((t, idx) => {
        const isActive = t.id === activeId;
        const coverUrl = getCoverUrl(t);
        const coverStyle = coverUrl ? `background-image: url(${escapeCssUrl(coverUrl)})` : '';
        return `
        <div class="playlist-track-row flex items-center p-3 rounded-2xl border border-transparent ${isActive ? 'bg-[var(--bg-selection)] border-[var(--glass-border)]' : 'bg-[var(--bg-card)] hover:bg-[var(--surface-overlay)]'} transition-all cursor-pointer group" data-id="${t.id}" data-index="${idx}" onclick="typeof playTrack==='function'&&playTrack('${t.id}')">
            <div class="song-row-cover-wrapper relative w-12 h-12 flex-shrink-0">
                <div class="song-row-cover absolute inset-0 rounded-xl overflow-hidden bg-cover bg-center border border-[var(--glass-border)] shadow-lg" style="${coverStyle}" role="img" aria-label="Cover">
                    <div class="active-indicator-container absolute inset-0 flex items-center justify-center bg-[var(--accent)]/10 rounded-xl backdrop-blur-[1.6px] transition-all duration-150 ease-out pointer-events-none ${isActive ? 'opacity-100 is-playing' : 'opacity-0'}">
                        <i class="playing-icon fas fa-volume-high text-[var(--accent)] text-[14.4px]"></i>
                    </div>
                </div>
            </div>
            <div class="ml-4 flex-1 truncate">
                <div class="song-title font-bold text-sm truncate text-[var(--text-main)]">${esc(t.title)}</div>
                <div class="text-[10px] text-[var(--text-dim)] font-bold truncate uppercase tracking-widest mt-0.5 font-mono">${esc(t.artist)}</div>
            </div>
            <div class="flex items-center space-x-2 ml-4">
                <div class="text-[9px] font-bold font-mono text-[var(--text-dim)] opacity-50">${formatTime(t.duration)}</div>
                <button type="button" onclick="event.stopPropagation(); typeof removeFromPlaylistTrack==='function'&&removeFromPlaylistTrack('${safeName}','${t.id}')" class="w-10 h-10 flex items-center justify-center rounded-full text-[var(--text-dim)] hover:text-red-400 hover:bg-red-500/10 transition-colors focus:outline-none" aria-label="Remove from playlist">
                    <i class="fas fa-times text-xs"></i>
                </button>
            </div>
        </div>
        `;
    }).join('');
}

/**
 * Render playlist detail (tracks) into container. Same row layout as "all songs"; optional search filter.
 * @param {string} playlistName
 * @param {Array} trackIds - ordered list of track ids
 * @param {Array} library
 * @param {HTMLElement|null} tracksContainerEl
 * @param {Object} options - { searchQuery, getCoverUrl }
 */
export function renderPlaylistDetail(playlistName, trackIds, library, tracksContainerEl, options = {}) {
    if (!tracksContainerEl) return;
    const query = (options.searchQuery || '').trim().toLowerCase();
    const tracks = (trackIds || [])
        .map((id) => (library || []).find((t) => t.id === id))
        .filter(Boolean);
    const filtered = query
        ? tracks.filter((t) =>
            (t.title || '').toLowerCase().includes(query) ||
            (t.artist || '').toLowerCase().includes(query) ||
            (t.album || '').toLowerCase().includes(query))
        : tracks;
    if (filtered.length === 0) {
        tracksContainerEl.innerHTML = query
            ? '<div class="text-[var(--text-dim)] text-center py-10 italic text-sm">No matches in this playlist.</div>'
            : '<div class="text-[var(--text-dim)] text-center py-10 italic text-sm">No tracks. Add some from Library.</div>';
        return;
    }
    tracksContainerEl.innerHTML = buildSongRowsHtml(filtered, {
        getCoverUrl: options.getCoverUrl || Resolver.getCoverUrl.bind(Resolver),
        addDataIndex: true
    });
}
