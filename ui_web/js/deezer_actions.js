/**
 * Deezer surface rows (Discover home/search, editorial playlist detail): action menu + queue/favourites
 * using YouTube resolution (same path as preview playback).
 */
import { store } from './store.js';
import { getYouTubeWatchUrlForTrack, shareYouTubeTrack } from './shared.js';
import { searchService } from './search_service.js';

export function isDeezerSurfaceActionTrack(track) {
    if (!track || typeof track !== 'object') return false;
    if (track.source === 'deezer_surface') return true;
    return typeof track.id === 'string' && track.id.startsWith('deezer_');
}

export function findDeezerSurfaceTrackByRowId(rowId) {
    const lists = [window._discoverSurfaceTracks, window._currentPlaylistTracks].filter((x) => Array.isArray(x));
    for (const list of lists) {
        const hit = list.find((t) => t && t.id === rowId);
        if (hit) return hit;
    }
    return null;
}

/**
 * @param {string} rowId e.g. deezer_123
 * @returns {object|null} virtual track for action menus
 */
export function buildVirtualTrackForDeezerRow(rowId) {
    const st = findDeezerSurfaceTrackByRowId(rowId);
    if (!st) return null;
    const raw = String(rowId).replace(/^deezer_/, '');
    const deezerKey = st.deezerId != null ? st.deezerId : raw;
    return {
        id: rowId,
        title: st.title || 'Unknown',
        artist: st.artist || '',
        duration: Number(st.duration) || 0,
        cover: typeof st.cover === 'string' ? st.cover : '',
        album: st.album || '',
        source: 'deezer_surface',
        deezerId: deezerKey,
        youtube_id: undefined,
        _resolvedOdst: null,
        _libraryTrackId: undefined,
        _hydratePromise: null
    };
}

export async function hydrateDeezerVirtualTrack(track) {
    if (!isDeezerSurfaceActionTrack(track)) return track;
    if (track.youtube_id) return track;
    if (track._hydratePromise) return track._hydratePromise;
    track._hydratePromise = (async () => {
        const { resolveDeezerTrackToOdstItem } = await import('./discovery.js');
        const like = {
            title: track.title,
            artist: track.artist,
            deezerId: track.deezerId
        };
        const odst = await resolveDeezerTrackToOdstItem(like);
        track._resolvedOdst = odst;
        if (odst && odst.id) {
            track.youtube_id = odst.id;
            const map = store.state.youtubeToTrackId || {};
            if (map[odst.id]) track._libraryTrackId = map[odst.id];
        }
        return track;
    })();
    return track._hydratePromise;
}

function editorialDeezerPlaylistOpen() {
    return !!window._deezerPlaylistDetail;
}

const DEEZER_MENU_LAYOUT = {
    'mobile-action': {
        favText: 'action-fav-text',
        queueText: 'action-queue-text',
        share: 'action-share',
        add: 'action-add-to-playlist',
        edit: 'action-edit-metadata',
        delete: 'action-delete',
        remove: 'action-remove-from-playlist'
    },
    'desktop-action': {
        favText: 'desktop-action-fav-text',
        queueText: 'desktop-action-queue-text',
        share: 'desktop-action-share',
        add: 'desktop-action-add-to-playlist',
        edit: 'desktop-action-edit-metadata',
        delete: 'desktop-action-delete',
        remove: 'desktop-action-remove-from-playlist'
    },
    'desktop-context': {
        favText: 'desktop-context-fav-text',
        queueText: 'desktop-context-queue-text',
        share: 'desktop-context-share',
        add: 'desktop-context-add-to-playlist',
        edit: 'desktop-context-edit-metadata',
        delete: 'desktop-context-delete',
        remove: 'desktop-context-remove-from-playlist'
    }
};

/**
 * Sync action sheet / context menu labels and visibility for a hydrated or pre-hydration Deezer virtual track.
 * @param {'mobile-action'|'desktop-action'|'desktop-context'} surface
 * @param {{ inPlaylistDetail?: boolean }} ctx
 */
export function applyDeezerActionMenuChrome(track, surface, ctx = {}) {
    const inPl = !!ctx.inPlaylistDetail;
    const editorial = editorialDeezerPlaylistOpen();

    const ids = DEEZER_MENU_LAYOUT[surface] || DEEZER_MENU_LAYOUT['mobile-action'];

    const favText = document.getElementById(ids.favText);
    const queueText = document.getElementById(ids.queueText);
    const shareEl = document.getElementById(ids.share);
    const addEl = document.getElementById(ids.add);
    const editEl = document.getElementById(ids.edit);
    const deleteEl = document.getElementById(ids.delete);
    const removeEl = document.getElementById(ids.remove);

    const libId = track._libraryTrackId;
    const isFav = libId && (store.state.favorites || []).includes(libId);
    if (favText) {
        favText.textContent = !libId
            ? 'Add to Favourites'
            : (isFav ? 'Remove from Favourites' : 'Add to Favourites');
    }

    const vid = track.youtube_id;
    const inQ = !!(vid && (store.state.queue || []).some((t) => t.id === vid));
    if (queueText) queueText.textContent = inQ ? 'Remove from Queue' : 'Add to Queue';

    if (shareEl) {
        const showShare = !!getYouTubeWatchUrlForTrack({ youtube_id: track.youtube_id });
        shareEl.classList.toggle('hidden', !showShare);
    }

    if (addEl) addEl.classList.toggle('hidden', inPl || !libId);
    if (editEl) editEl.classList.add('hidden');
    if (deleteEl) deleteEl.classList.add('hidden');

    if (removeEl) {
        const showRemove = inPl && !editorial && !!libId;
        removeEl.classList.toggle('hidden', !showRemove);
    }
}

export async function actionMenuToggleQueueDeezer(track, storeRef, showToast) {
    await hydrateDeezerVirtualTrack(track);
    if (!track.youtube_id || !track._resolvedOdst) {
        showToast?.('No YouTube match');
        return;
    }
    const vid = track.youtube_id;
    const inQ = (storeRef.state.queue || []).some((t) => t.id === vid);
    if (inQ) {
        await storeRef.removeFromQueueById(vid);
        showToast?.('Removed from Queue');
    } else {
        const ok = await storeRef.addPreviewToQueue(track._resolvedOdst);
        showToast?.(ok ? 'Added to Queue' : 'Could not add to queue');
    }
}

export async function actionMenuToggleFavDeezer(track, storeRef, showToast) {
    await hydrateDeezerVirtualTrack(track);
    const libId = track._libraryTrackId;
    if (!libId) {
        showToast?.('Download to library to use favourites');
        return;
    }
    storeRef.toggleFavourite(libId);
}

export async function actionMenuShareDeezer(track, showToast) {
    await hydrateDeezerVirtualTrack(track);
    if (getYouTubeWatchUrlForTrack({ youtube_id: track.youtube_id })) {
        await shareYouTubeTrack({ youtube_id: track.youtube_id, title: track.title, artist: track.artist }, showToast);
    } else {
        showToast?.('No YouTube match');
    }
}

export async function actionMenuAddToPlaylistDeezer(track, showToast, onAddToPlaylistLibId) {
    await hydrateDeezerVirtualTrack(track);
    const libId = track._libraryTrackId;
    if (!libId) {
        showToast?.('Download to library to use playlists');
        return;
    }
    onAddToPlaylistLibId?.(libId);
}

/**
 * ODST search–style playback-queue and download buttons on Deezer rows (discover + editorial playlists).
 * @param {HTMLElement|null} containerEl
 */
export function bindDiscoverSurfaceQuickActionButtons(containerEl) {
    if (!containerEl) return;
    containerEl.querySelectorAll('.dl-playback-queue[data-deezer-id]').forEach((btn) => {
        const raw = btn.getAttribute('data-deezer-id');
        if (!raw) return;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            void import('./discovery.js').then((m) => {
                if (typeof m.addDeezerTrackToQueueByNumericId === 'function') {
                    void m.addDeezerTrackToQueueByNumericId(raw);
                }
            });
        });
    });
    containerEl.querySelectorAll('.dl-add-one[data-deezer-id]').forEach((btn) => {
        const raw = btn.getAttribute('data-deezer-id');
        if (!raw) return;
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const Dl = typeof window.Downloader !== 'undefined' ? window.Downloader : null;
            if (Dl?.primeDownloadQueueUi) Dl.primeDownloadQueueUi();
            try {
                const rowId = `deezer_${raw}`;
                let like = null;
                const st = findDeezerSurfaceTrackByRowId(rowId);
                if (st) {
                    like = {
                        title: st.title,
                        artist: st.artist,
                        deezerId: st.deezerId != null ? st.deezerId : Number(raw)
                    };
                } else {
                    const m = await import('./discovery.js');
                    if (typeof m.fetchDeezerTrackLikeByNumericId === 'function') {
                        like = await m.fetchDeezerTrackLikeByNumericId(raw);
                    }
                }
                if (!like) {
                    window.showToast?.('Could not load track');
                    return;
                }
                const { resolveDeezerTrackToOdstItem } = await import('./discovery.js');
                const odst = await resolveDeezerTrackToOdstItem(like);
                if (!odst?.id) {
                    window.showToast?.('No YouTube match — try search');
                    return;
                }
                if (Dl?.addToDownloadQueue) {
                    Dl.addToDownloadQueue(odst, { source: searchService.sourceMode });
                    window.showToast?.('Added to download queue');
                }
            } catch (_) {
                window.showToast?.('Could not add to download queue');
            } finally {
                if (Dl?.releaseDownloadQueueUiPrime) Dl.releaseDownloadQueueUiPrime();
            }
        });
    });
}
