/**
 * Shared frontend helpers used by both mobile and desktop shells.
 */
import { Resolver } from './resolver.js';

function escHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function escapeCssUrl(url) {
    if (!url) return '';
    return String(url).replace(/"/g, '%22').replace(/'/g, '%27');
}

/**
 * Which library track supplies artwork for a playlist card / detail hero.
 * @param {string} playlistName
 * @param {string[]} trackIds
 * @param {object[]} library
 * @param {object|null|undefined} librarySettings
 * @returns {object|null}
 */
export function resolvePlaylistCoverTrack(playlistName, trackIds, library, librarySettings) {
    if (!trackIds?.length || !library?.length) return null;
    const covers = librarySettings?.playlist_covers;
    const preferredId = covers && typeof covers === 'object' ? covers[playlistName] : null;
    const byId = new Map(library.map((t) => [t.id, t]));
    if (typeof preferredId !== 'string' || !preferredId) {
        const t = byId.get(trackIds[0]);
        return t ?? null;
    }
    if (!trackIds.includes(preferredId)) {
        const t = byId.get(trackIds[0]);
        return t ?? null;
    }
    return byId.get(preferredId) ?? byId.get(trackIds[0]) ?? null;
}

export function filterPlaylistsBySearch(playlists, query) {
    if (!query) return playlists;
    const q = query.trim().toLowerCase();
    const out = {};
    Object.keys(playlists || {}).forEach((name) => {
        if (name.toLowerCase().includes(q)) out[name] = playlists[name];
    });
    return out;
}

export function getPointerCoords(e) {
    if (e.clientX != null) return { x: e.clientX, y: e.clientY };
    if (e.touches?.[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    if (e.changedTouches?.[0]) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    return { x: 0, y: 0 };
}

const YOUTUBE_VIDEO_ID_LEN = 11;
const YOUTUBE_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

/**
 * True when the track is playing via /api/preview/stream (yt-dlp), not a library file stream.
 * @param {{ source?: string, id?: string, _libraryTrackId?: string } | null | undefined} track
 */
export function isYtdlpPreviewStreamTrack(track) {
    if (!track || track.source !== 'preview' || track._libraryTrackId) return false;
    const id = track.id;
    if (typeof id !== 'string' || id.startsWith('raw-')) return false;
    return id.length === YOUTUBE_VIDEO_ID_LEN && YOUTUBE_VIDEO_ID_RE.test(id);
}

/** @param {{ youtube_id?: string } | null | undefined} track */
export function getYouTubeWatchUrlForTrack(track) {
    const id = track?.youtube_id;
    if (typeof id !== 'string' || id.length !== YOUTUBE_VIDEO_ID_LEN || !YOUTUBE_VIDEO_ID_RE.test(id)) return null;
    return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
}

/**
 * @param {{ youtube_id?: string, title?: string, artist?: string } | null | undefined} track
 * @returns {{ url: string, title: string, text: string } | null}
 */
export function buildYouTubeSharePayload(track) {
    const url = getYouTubeWatchUrlForTrack(track);
    if (!url) return null;
    const title = (track?.title != null && String(track.title).trim()) || 'Unknown';
    const artist = track?.artist != null ? String(track.artist).trim() : '';
    const text = artist ? `${artist} — ${title}` : title;
    return { url, title, text };
}

/**
 * @param {{ url: string, title?: string, text?: string }} payload
 */
function pickShareData(payload) {
    const minimal = { url: payload.url };
    const hasMeta =
        typeof payload.title === 'string' &&
        typeof payload.text === 'string';
    const full = hasMeta ? { url: payload.url, title: payload.title, text: payload.text } : null;

    if (typeof navigator.canShare !== 'function') {
        return full || minimal;
    }
    if (full && navigator.canShare(full)) return full;
    if (navigator.canShare(minimal)) return minimal;
    return minimal;
}

/**
 * Web Share API when available (native sheet on iOS/Android), else clipboard.
 * @param {{ url: string, title?: string, text?: string }} payload
 */
async function shareOrCopyPayload(payload, showToast) {
    if (!payload?.url) return;
    if (navigator.share && typeof navigator.share === 'function') {
        const shareData = pickShareData(payload);
        try {
            await navigator.share(shareData);
            return;
        } catch (e) {
            if (e && e.name === 'AbortError') return;
        }
    }
    if (await copyUrlToClipboard(payload.url)) {
        showToast?.('Link copied');
    } else {
        showToast?.('Could not share');
    }
}

/**
 * @param {{ youtube_id?: string, title?: string, artist?: string } | null | undefined} track
 */
export async function shareYouTubeTrack(track, showToast) {
    const p = buildYouTubeSharePayload(track);
    if (p) await shareOrCopyPayload(p, showToast);
}

/**
 * Synchronous copy — works on non-secure origins (e.g. http://LAN:port) and when
 * transient activation was consumed by a prior await (e.g. failed navigator.share).
 */
function copyTextViaExecCommand(text) {
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.readOnly = true;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}

async function copyUrlToClipboard(url) {
    if (copyTextViaExecCommand(url)) return true;
    if (!navigator.clipboard?.writeText) return false;
    try {
        await navigator.clipboard.writeText(url);
        return true;
    } catch {
        return false;
    }
}

export async function shareOrCopyUrl(url, showToast) {
    if (!url) return;
    await shareOrCopyPayload({ url }, showToast);
}

export function bindPlaylistWindowActions(options) {
    const {
        store,
        getCurrentPlaylistName,
        setCurrentPlaylistName,
        renderPlaylistDetail,
        showPlaylistList
    } = options;

    window.removeFromPlaylistTrack = (playlistName, trackId) => {
        store.removeFromPlaylist(playlistName, trackId).then(() => {
            if (getCurrentPlaylistName() === playlistName) renderPlaylistDetail(playlistName);
        });
    };

    window.createPlaylistPrompt = () => {
        const name = prompt('Playlist name');
        if (name != null && name.trim()) store.createPlaylist(name.trim());
    };

    window.renamePlaylistPrompt = () => {
        const current = getCurrentPlaylistName();
        if (!current) return;
        const newName = prompt('Rename playlist', current);
        if (newName != null && newName.trim() && newName.trim() !== current) {
            store.renamePlaylist(current, newName.trim()).then(() => {
                setCurrentPlaylistName(newName.trim());
                renderPlaylistDetail(newName.trim());
            });
        }
    };

    window.duplicatePlaylistPrompt = () => {
        const current = getCurrentPlaylistName();
        if (!current) return;
        const newName = prompt('Duplicate as', `${current} (copy)`);
        if (newName != null && newName.trim()) store.duplicatePlaylist(current, newName.trim());
    };

    window.deletePlaylistConfirm = () => {
        const current = getCurrentPlaylistName();
        if (!current) return;
        if (!confirm(`Delete playlist "${current}"?`)) return;
        store.deletePlaylist(current).then(() => {
            setCurrentPlaylistName(null);
            window._currentPlaylistTracks = null;
            showPlaylistList();
        });
    };
}

export function showAddToPlaylistPicker(options) {
    const {
        store,
        toast,
        itemPaddingClass = 'p-4',
        itemHoverClass = 'active:bg-[var(--surface-overlay)]',
        addHoverClass = 'active:bg-[var(--accent)]/15'
    } = options;
    return (trackId) => {
        const picker = document.getElementById('add-to-playlist-picker');
        const listEl = document.getElementById('add-to-playlist-picker-list');
        const backdrop = document.getElementById('add-to-playlist-picker-backdrop');
        const closeBtn = document.getElementById('add-to-playlist-picker-close');
        if (!picker || !listEl) return;
        window._addToPlaylistTrackId = trackId;
        const playlists = store.state.playlists || {};
        const names = Object.keys(playlists).sort((a, b) => a.localeCompare(b));
        const baseClass = `add-to-playlist-picker-item w-full flex items-center gap-3 ${itemPaddingClass} rounded-xl text-left font-bold text-sm transition-colors`;
        listEl.innerHTML = names.map((name) => (
            `<button type="button" class="${baseClass} ${itemHoverClass} text-[var(--text-main)]" data-playlist-name="${escHtml(name)}"><i class="fas fa-layer-group text-[var(--text-dim)] w-4"></i><span>${escHtml(name)}</span></button>`
        )).join('') + `<button type="button" class="${baseClass} ${addHoverClass} text-[var(--accent)]" data-new-playlist><i class="fas fa-plus w-4"></i><span>New playlist...</span></button>`;
        const hide = () => {
            picker.classList.add('hidden');
            window._addToPlaylistTrackId = null;
        };
        listEl.querySelectorAll('.add-to-playlist-picker-item').forEach((btn) => {
            btn.addEventListener('click', () => {
                const name = btn.getAttribute('data-playlist-name');
                const isNew = btn.hasAttribute('data-new-playlist');
                const tid = window._addToPlaylistTrackId;
                hide();
                if (!tid) return;
                if (isNew) {
                    const newName = prompt('Playlist name');
                    if (newName != null && newName.trim()) {
                        const trimmed = newName.trim();
                        store.createPlaylist(trimmed).then(() => store.addToPlaylist(trimmed, tid)).then(() => toast(`Added to ${trimmed}`));
                    }
                } else if (name) {
                    store.addToPlaylist(name, tid).then(() => toast(`Added to ${name}`));
                }
            });
        });
        if (backdrop) backdrop.addEventListener('click', hide, { once: true });
        if (closeBtn) closeBtn.addEventListener('click', hide, { once: true });
        picker.classList.remove('hidden');
    };
}

/**
 * @param {object} options
 * @param {object} options.store
 * @param {(msg: string) => void} [options.toast]
 * @param {() => void} [options.onApplied]
 */
/** Body class: blurs main shell so fixed UI (search bar, rows) is not left sharp — backdrop-filter often skips those layers. */
const PLAYLIST_COVER_PICKER_BODY_CLASS = 'playlist-cover-picker-open';

export function showPlaylistCoverPicker(options) {
    const { store, toast, onApplied } = options;
    return (playlistName, tracks) => {
        const picker = document.getElementById('playlist-cover-picker');
        const gridEl = document.getElementById('playlist-cover-picker-grid');
        const backdrop = document.getElementById('playlist-cover-picker-backdrop');
        const closeBtn = document.getElementById('playlist-cover-picker-close');
        const defaultBtn = document.getElementById('playlist-cover-picker-default');
        const headingEl = document.getElementById('playlist-cover-picker-heading');
        if (!picker || !gridEl || !tracks?.length) return;
        if (headingEl) {
            headingEl.textContent = playlistName ? `Playlist cover — ${playlistName}` : 'Playlist cover';
        }

        const hide = () => {
            picker.classList.add('hidden');
            document.body.classList.remove(PLAYLIST_COVER_PICKER_BODY_CLASS);
            window._playlistCoverPickerName = null;
        };

        window._playlistCoverPickerName = playlistName;

        gridEl.innerHTML = tracks.map((t) => {
            const coverUrl = Resolver.getCoverUrl(t);
            const style = coverUrl ? `background-image: url(${escapeCssUrl(coverUrl)})` : '';
            const title = (t.title != null && String(t.title)) || 'Unknown';
            return `
<button type="button" class="playlist-cover-picker-tile flex flex-col gap-1.5 text-left rounded-[var(--radius-omni-xs)] border border-[var(--glass-border)] bg-[var(--bg-card)] overflow-hidden active:bg-[var(--surface-overlay)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" data-track-id="${escHtml(t.id)}">
<div class="aspect-square w-full bg-[var(--surface-overlay)] bg-cover bg-center" style="${style}" role="img" aria-label="${escHtml(title)}"></div>
<p class="px-1.5 pb-2 text-[10px] font-semibold text-[var(--text-main)] leading-tight truncate" title="${escHtml(title)}">${escHtml(title)}</p>
</button>`.trim();
        }).join('');

        gridEl.querySelectorAll('.playlist-cover-picker-tile').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.getAttribute('data-track-id');
                hide();
                if (!id) return;
                store.setPlaylistCover(playlistName, id).then((ok) => {
                    if (ok) {
                        onApplied?.();
                    } else toast?.('Could not update cover');
                });
            });
        });

        const applyDefault = () => {
            hide();
            store.setPlaylistCover(playlistName, null).then((ok) => {
                if (ok) {
                    toast?.('Using default cover');
                    onApplied?.();
                } else toast?.('Could not update cover');
            });
        };
        if (defaultBtn) defaultBtn.onclick = applyDefault;
        if (closeBtn) closeBtn.onclick = hide;
        if (backdrop) backdrop.onclick = hide;
        document.body.classList.add(PLAYLIST_COVER_PICKER_BODY_CLASS);
        picker.classList.remove('hidden');
    };
}

export function initLibraryMaintenanceControls(options) {
    const {
        store,
        audioEngine,
        openButtonId,
        purgeButtonId,
        toast,
        onAfterSync
    } = options;

    const modal = document.getElementById('wipe-library-modal');
    const backdrop = document.getElementById('wipe-library-modal-backdrop');
    const input = document.getElementById('wipe-library-confirm-input');
    const cancelBtn = document.getElementById('wipe-library-cancel');
    const submitBtn = document.getElementById('wipe-library-submit');
    const errorEl = document.getElementById('wipe-library-error');
    const openBtn = document.getElementById(openButtonId);

    if (modal && input && submitBtn && openBtn) {
        const showModal = () => {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            input.value = '';
            submitBtn.disabled = true;
            if (errorEl) { errorEl.classList.add('hidden'); errorEl.textContent = ''; }
            input.focus();
        };
        const hideModal = () => {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            input.value = '';
            submitBtn.disabled = true;
            if (errorEl) { errorEl.classList.add('hidden'); errorEl.textContent = ''; }
        };
        const checkConfirm = () => {
            const v = input.value.trim();
            submitBtn.disabled = v !== 'CONFIRM' && v !== 'confirm';
            if (errorEl) errorEl.classList.add('hidden');
        };

        openBtn.addEventListener('click', showModal);
        input.addEventListener('input', checkConfirm);
        input.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideModal(); });
        cancelBtn?.addEventListener('click', hideModal);
        backdrop?.addEventListener('click', hideModal);

        submitBtn.addEventListener('click', async () => {
            if (submitBtn.disabled) return;
            const confirmVal = input.value.trim();
            if (confirmVal !== 'CONFIRM' && confirmVal !== 'confirm') return;
            submitBtn.disabled = true;
            if (errorEl) { errorEl.classList.add('hidden'); errorEl.textContent = ''; }
            try {
                const res = await fetch(`${store.apiBase}/api/library/wipe`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ confirm: confirmVal })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    if (errorEl) {
                        errorEl.textContent = data.error || 'Wipe failed';
                        errorEl.classList.remove('hidden');
                    }
                    submitBtn.disabled = false;
                    toast(data.error || 'Wipe failed');
                    return;
                }
                hideModal();
                store.update({
                    library: [],
                    queue: [],
                    playlists: {},
                    favorites: [],
                    libraryYoutubeIds: [],
                    youtubeToTrackId: {},
                    currentTrack: null,
                    isPlaying: false
                });
                store.save('library', []);
                store.save('playlists', {});
                store.save('favorites', []);
                if (audioEngine?.pause) audioEngine.pause();
                await store.syncLibrary();
                onAfterSync?.();
                toast('Library wiped');
            } catch (err) {
                if (errorEl) {
                    errorEl.textContent = err.message || 'Request failed';
                    errorEl.classList.remove('hidden');
                }
                submitBtn.disabled = false;
                toast(err.message || 'Request failed');
            }
        });
    }

    const purgeBtn = document.getElementById(purgeButtonId);
    if (!purgeBtn) return;
    purgeBtn.addEventListener('click', async () => {
        purgeBtn.disabled = true;
        purgeBtn.classList.add('opacity-60', 'cursor-wait');
        try {
            const res = await fetch(`${store.apiBase}/api/library/purge-missing`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                toast(data.error || 'Purge failed');
            } else {
                const checked = typeof data.checked === 'number' ? data.checked : 0;
                const removed = typeof data.removed === 'number' ? data.removed : 0;
                const msg = removed === 0
                    ? 'No missing tracks found'
                    : `Removed ${removed} missing ${removed === 1 ? 'track' : 'tracks'} (checked ${checked})`;
                await store.syncLibrary();
                onAfterSync?.();
                toast(msg);
            }
        } catch (err) {
            toast(err?.message || 'Purge failed');
        } finally {
            purgeBtn.disabled = false;
            purgeBtn.classList.remove('opacity-60', 'cursor-wait');
        }
    });
}
