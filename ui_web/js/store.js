/**
 * State Management Store
 */
import { connectionManager } from './connection.js';
import { STATION_PORT, getApiBase } from './config.js';

/** Best-effort IndexedDB mirror for disaster recovery (localStorage remains source of truth). */
function scheduleLibraryIdbMirror(library) {
    if (typeof indexedDB === 'undefined' || !Array.isArray(library) || library.length === 0) return;
    const run = () => {
        try {
            const req = indexedDB.open('soundsible', 1);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
            };
            req.onsuccess = () => {
                try {
                    const db = req.result;
                    const tx = db.transaction('kv', 'readwrite');
                    tx.objectStore('kv').put(library, 'library_mirror');
                } catch (_) {}
            };
        } catch (_) {}
    };
    if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(run, { timeout: 4000 });
    else setTimeout(run, 1);
}

class Store {
    constructor() {
        this.state = {
            config: this.load('config', {
                host: window.location.hostname || 'localhost',
                port: STATION_PORT,
                syncToken: null
            }),
            priorityList: this.load('priority_list', []),
            activeHost: window.location.hostname || 'localhost',
            isOnline: true,
            library: this.load('library', []),
            libraryYoutubeIds: [],
            youtubeToTrackId: {},
            favorites: this.load('favorites', []),
            playlists: this.load('playlists', {}),
            librarySettings: this.load('library_settings', {}),
            queue: [],
            repeatMode: 'off', // Note: Off = no repeat, one = infinite repeat of current song, once = repeat current song one time then continue
            shuffleEnabled: false,
            currentTrack: null,
            isPlaying: false,
            theme: (() => {
                const t = this.load('theme', 'dark');
                return ['dark', 'light', 'odst'].includes(t) ? t : 'dark';
            })(),
            appIcon: (() => {
                const a = this.load('app_icon', 'default');
                return ['default', 'alt'].includes(a) ? a : 'default';
            })(),
            hapticsEnabled: this.load('haptics', true),
            libraryOrder: this.load('library_order', 'date_added'),
            songsViewMode: (() => { const v = this.load('songs_view_mode', 'list'); const valid = ['list', 'grid', 'gridCompact', 'gridLarge']; return valid.includes(v) ? v : (v === 'gridXLarge' ? 'gridLarge' : 'list'); })(),
            artistViewMode: (() => { const v = this.load('artist_view_mode', 'gridCompact'); const valid = ['gridCompact', 'grid', 'gridLarge']; return valid.includes(v) ? v : (v === 'gridXLarge' ? 'gridLarge' : 'gridCompact'); })(),
            libraryTab: (() => { const v = this.load('library_tab', 'songs'); return v === 'artists' ? 'artists' : 'songs'; })(),
            volume: (() => {
                const savedVolume = Number(this.load('volume', 1));
                const v = Number.isFinite(savedVolume) ? Math.min(1, Math.max(0, savedVolume)) : 1;
                return v;
            })(),
            volumeBeforeMute: (() => {
                const v = this.load('volumeBeforeMute', 1);
                return Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : 1;
            })()
        };
        this.subscribers = [];
        this._syncLibraryVersion = 0;
        this._syncLibraryInFlight = false;
        this._youtubeIdsVersion = 0;
        /** Set when the user has started playback this page load (not persisted). Used to avoid resume-sync racing the first tap. */
        this._userPlaybackStartedThisSession = false;
        this.applyTheme(this.state.theme);
    }

    markUserPlaybackStarted() {
        this._userPlaybackStartedThisSession = true;
    }

    hasUserPlaybackStarted() {
        return this._userPlaybackStartedThisSession;
    }

    applyTheme(theme) {
        const valid = ['dark', 'light', 'odst'].includes(theme) ? theme : 'dark';
        document.documentElement.setAttribute('data-theme', valid);
        this.save('theme', valid);
        const meta = document.querySelector('#meta-theme-color');
        if (meta) {
            const color = valid === 'light' ? '#f5f5f5' : valid === 'odst' ? '#1c2026' : '#0d0d0f';
            meta.setAttribute('content', color);
        }
    }

    setTheme(theme) {
        const valid = ['dark', 'light', 'odst'].includes(theme) ? theme : 'dark';
        this.update({ theme: valid });
        this.applyTheme(valid);
    }

    toggleTheme() {
        const newTheme = this.state.theme === 'dark' ? 'light' : 'dark';
        this.update({ theme: newTheme });
        this.applyTheme(newTheme);
    }

    setAppIcon(value) {
        const valid = ['default', 'alt'].includes(value) ? value : 'default';
        this.update({ appIcon: valid });
    }

    toggleHaptics() {
        const newVal = !this.state.hapticsEnabled;
        this.update({ hapticsEnabled: newVal });
        this.save('haptics', newVal);
    }

    load(key, fallback) {
        try {
            const data = localStorage.getItem(`soundsible_${key}`);
            return data ? JSON.parse(data) : fallback;
        } catch (e) {
            console.error(`Failed to load key ${key}:`, e);
            return fallback;
        }
    }

    save(key, val) {
        try {
            localStorage.setItem(`soundsible_${key}`, JSON.stringify(val));
        } catch (e) {
            console.error(`Failed to save key ${key}:`, e);
        }
    }

    update(patch) {
        let changed = false;
        for (const key in patch) {
            // Note: Shallow equality check for primitive values (status, isplaying, etc)
            if (this.state[key] !== patch[key]) {
                changed = true;
                break;
            }
        }
        
        if (!changed) return;

        this.state = { ...this.state, ...patch };
        if (patch.libraryOrder !== undefined) this.save('library_order', patch.libraryOrder);
        if (patch.appIcon !== undefined) this.save('app_icon', patch.appIcon);
        if (patch.songsViewMode !== undefined) this.save('songs_view_mode', patch.songsViewMode);
        if (patch.artistViewMode !== undefined) this.save('artist_view_mode', patch.artistViewMode);
        if (patch.libraryTab !== undefined) {
            const v = patch.libraryTab;
            if (v === 'artists' || v === 'songs') this.save('library_tab', v);
        }
        if (patch.volume !== undefined) this.save('volume', patch.volume);
        if (patch.volumeBeforeMute !== undefined) this.save('volumeBeforeMute', patch.volumeBeforeMute);
        if (patch.playlists !== undefined) this.save('playlists', patch.playlists);
        if (patch.librarySettings !== undefined) this.save('library_settings', patch.librarySettings);
        if (patch.library !== undefined) {
            this.save('library', patch.library);
            scheduleLibraryIdbMirror(patch.library);
        }
        this.subscribers.forEach(cb => cb(this.state));
    }

    subscribe(cb) {
        this.subscribers.push(cb);
        return () => {
            this.subscribers = this.subscribers.filter(s => s !== cb);
        };
    }

    get apiBase() {
        return getApiBase(this.state.activeHost);
    }

    /**
     * Startup routing only: uses state already loaded from localStorage (no network).
     * Treats non-empty favorites or playlists as "has used library" for users whose tracks
     * were not persisted before library sync started saving to disk.
     */
    hasLocalLibrarySignal() {
        if (this.state.library && this.state.library.length > 0) return true;
        if (Array.isArray(this.state.favorites) && this.state.favorites.length > 0) return true;
        const pl = this.state.playlists;
        if (pl && typeof pl === 'object') {
            for (const k of Object.keys(pl)) {
                const tracks = pl[k];
                if (Array.isArray(tracks) && tracks.length > 0) return true;
            }
        }
        return false;
    }

    /** Stable device id for playback sync (persisted in localStorage). */
    getDeviceId() {
        let id = this.load('device_id', null);
        if (!id) {
            id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
            this.save('device_id', id);
        }
        return id;
    }

    /** Short device name for "Resume from {device}?" (v1: Desktop vs Mobile from path). */
    getDeviceName() {
        return (typeof window !== 'undefined' && window.location.pathname.includes('desktop')) ? 'Desktop' : 'Mobile';
    }

    /** Push current playback state to server (for cross-device resume). Fire-and-forget. */
    pushPlaybackState(trackId, positionSec, isPlaying) {
        const deviceId = this.getDeviceId();
        const deviceName = this.getDeviceName();
        const body = JSON.stringify({
            track_id: trackId || null,
            position_sec: typeof positionSec === 'number' ? positionSec : 0,
            is_playing: !!isPlaying,
            device_id: deviceId,
            device_name: deviceName
        });
        fetch(`${this.apiBase}/api/playback/state`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body
        }).catch(() => {});
    }

    get placeholderCoverUrl() {
        return this.state.appIcon === 'alt' ? 'assets/icons/icon-alt-512.png' : 'assets/icons/icon-512.png';
    }

    get placeholderCoverUrl192() {
        return this.state.appIcon === 'alt' ? 'assets/icons/icon-alt-192.png' : 'assets/icons/icon-192.png';
    }

    async syncLibrary() {
        if (this._syncLibraryInFlight) return false;
        this._syncLibraryInFlight = true;
        const syncVersion = ++this._syncLibraryVersion;
        const host = this.state.activeHost;
        const port = this.state.config.port;
        const url = `http://${host}:${port}/api/library?t=${Date.now()}`;
        const apiBase = this.apiBase;

        try {
            // Note: Run library + favourites + queue in parallel (was 3 sequential round-trips).
            const ts = Date.now();
            const [libRes, favRes, queueRes] = await Promise.all([
                fetch(url),
                fetch(`${apiBase}/api/library/favourites?t=${ts}`).catch(() => ({ ok: false })),
                fetch(`${apiBase}/api/playback/queue?t=${ts}`).catch(() => ({ ok: false }))
            ]);

            if (!libRes.ok) throw new Error("Sync failed");
            const data = await libRes.json();

            let favIds = this.state.favorites;
            if (favRes.ok) {
                try {
                    favIds = await favRes.json();
                } catch (e) {
                    console.error("Favourites sync error:", e);
                }
            }

            let queueFromSync = null;
            let repeatModeFromSync;
            if (queueRes.ok) {
                try {
                    const qdata = await queueRes.json();
                    const raw = qdata.items ?? qdata.tracks ?? [];
                    queueFromSync = raw.map((item) => {
                        const out = { ...item };
                        if (out.library_track_id != null) out._libraryTrackId = out.library_track_id;
                        return out;
                    });
                    repeatModeFromSync = qdata.repeat_mode;
                } catch (e) {
                    console.error("Queue sync error:", e);
                }
            }

            if (syncVersion !== this._syncLibraryVersion) return false;
            const playlists = data.playlists && typeof data.playlists === 'object' ? data.playlists : {};
            const settings =
                data.settings !== undefined && data.settings !== null && typeof data.settings === 'object'
                    ? data.settings
                    : null;
            const patch = {
                library: Array.isArray(data.tracks) ? data.tracks : [],
                playlists,
                favorites: favIds,
                isOnline: true
            };
            if (settings) patch.librarySettings = settings;
            if (queueFromSync !== null) {
                patch.queue = queueFromSync;
                patch.repeatMode = repeatModeFromSync;
            }
            this.update(patch);
            this.save('favorites', favIds);

            // Note: YouTube id map is for discover/dedup — not needed to play local tracks; do not block sync.
            if (syncVersion !== this._syncLibraryVersion) return false;
            this.fetchLibraryYoutubeIds();
            return true;
        } catch (err) {
            console.error("Library sync error:", err);
            this.update({ isOnline: false });
            connectionManager.startReconnectionLoop();
            return false;
        } finally {
            this._syncLibraryInFlight = false;
        }
    }

    async fetchLibraryYoutubeIds() {
        const version = ++this._youtubeIdsVersion;
        try {
            const res = await fetch(`${this.apiBase}/api/library/youtube-ids?t=${Date.now()}`);
            if (!res.ok) return;
            const data = await res.json();
            if (version !== this._youtubeIdsVersion) return;
            const ids = Array.isArray(data.youtube_ids) ? data.youtube_ids : [];
            const map = data.youtube_to_track_id && typeof data.youtube_to_track_id === 'object' ? data.youtube_to_track_id : {};
            this.update({ libraryYoutubeIds: ids, youtubeToTrackId: map });
        } catch (err) {
            console.error("Library youtube-ids fetch error:", err);
        }
    }

    async syncFavourites() {
        try {
            const res = await fetch(`${this.apiBase}/api/library/favourites?t=${Date.now()}`);
            if (res.ok) {
                const favIds = await res.json();
                this.update({ favorites: favIds });
                this.save('favorites', favIds);
            }
        } catch (err) {
            console.error("Favourites sync error:", err);
        }
    }

    async syncQueue() {
        try {
            const res = await fetch(`${this.apiBase}/api/playback/queue?t=${Date.now()}`);
            if (res.ok) {
                const data = await res.json();
                const raw = data.items ?? data.tracks ?? [];
                const queue = raw.map((item) => {
                    const out = { ...item };
                    if (out.library_track_id != null) out._libraryTrackId = out.library_track_id;
                    return out;
                });
                this.update({
                    queue,
                    repeatMode: data.repeat_mode
                });
            }
        } catch (err) {
            console.error("Queue sync error:", err);
        }
    }

    async toggleShuffle() {
        const prev = this.state.shuffleEnabled;
        this.update({ shuffleEnabled: !prev });
        try {
            const res = await fetch(`${this.apiBase}/api/playback/shuffle`, { method: 'POST' });
            if (res.ok) {
                await this.syncQueue();
                return true;
            }
            this.update({ shuffleEnabled: prev });
            return false;
        } catch (err) {
            console.error("Shuffle error:", err);
            this.update({ shuffleEnabled: prev });
            return false;
        }
    }

    async toggleRepeat() {
        const modes = ['off', 'one', 'once']; // Note: Off → repeat (∞) → repeat(1) → off
        const prevMode = this.state.repeatMode;
        const nextMode = modes[(modes.indexOf(prevMode) + 1) % modes.length];
        this.update({ repeatMode: nextMode });
        try {
            const res = await fetch(`${this.apiBase}/api/playback/repeat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: nextMode })
            });
            if (res.ok) return true;
            this.update({ repeatMode: prevMode });
            return false;
        } catch (err) {
            console.error("Repeat toggle error:", err);
            this.update({ repeatMode: prevMode });
            return false;
        }
    }

    async toggleFavourite(trackId) {
        try {
            const wasFav = this.state.favorites.includes(trackId);
            const res = await fetch(`${this.apiBase}/api/library/favourites/toggle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ track_id: trackId })
            });
            if (res.ok) {
                await this.syncFavourites();
                if (!wasFav) {
                    const reordered = [trackId, ...this.state.favorites.filter(id => id !== trackId)];
                    this.update({ favorites: reordered });
                    this.save('favorites', reordered);
                }
                return true;
            }
            return false;
        } catch (err) {
            console.error("Toggle favourite error:", err);
            return false;
        }
    }

    async deleteTrack(trackId) {
        try {
            const res = await fetch(`${this.apiBase}/api/library/tracks/${trackId}`, {
                method: 'DELETE'
            });
            if (res.ok) {
                console.log("✓ Track deleted from Station Engine");
                await this.syncLibrary();
                return true;
            }
            return false;
        } catch (err) {
            console.error("Deletion error:", err);
            return false;
        }
    }

    async createPlaylist(name) {
        try {
            const res = await fetch(`${this.apiBase}/api/library/playlists`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: String(name).trim() })
            });
            if (res.ok) {
                const data = await res.json();
                const patch = {};
                if (data.playlists) patch.playlists = data.playlists;
                if (data.settings && typeof data.settings === 'object') patch.librarySettings = data.settings;
                if (Object.keys(patch).length) this.update(patch);
                else await this.syncLibrary();
                return true;
            }
            return false;
        } catch (err) {
            console.error("Create playlist error:", err);
            return false;
        }
    }

    async renamePlaylist(oldName, newName) {
        try {
            const res = await fetch(`${this.apiBase}/api/library/playlists/${encodeURIComponent(oldName)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: String(newName).trim() })
            });
            if (res.ok) {
                const data = await res.json();
                const patch = {};
                if (data.playlists) patch.playlists = data.playlists;
                if (data.settings && typeof data.settings === 'object') patch.librarySettings = data.settings;
                if (Object.keys(patch).length) this.update(patch);
                else await this.syncLibrary();
                return true;
            }
            return false;
        } catch (err) {
            console.error("Rename playlist error:", err);
            return false;
        }
    }

    async deletePlaylist(name) {
        try {
            const res = await fetch(`${this.apiBase}/api/library/playlists/${encodeURIComponent(name)}`, {
                method: 'DELETE'
            });
            if (res.ok) {
                const data = await res.json();
                const patch = {};
                if (data.playlists) patch.playlists = data.playlists;
                if (data.settings && typeof data.settings === 'object') patch.librarySettings = data.settings;
                if (Object.keys(patch).length) this.update(patch);
                else await this.syncLibrary();
                return true;
            }
            return false;
        } catch (err) {
            console.error("Delete playlist error:", err);
            return false;
        }
    }

    async addToPlaylist(playlistName, trackId) {
        try {
            const res = await fetch(`${this.apiBase}/api/library/playlists/${encodeURIComponent(playlistName)}/tracks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ track_id: trackId })
            });
            if (res.ok) {
                const data = await res.json();
                const patch = {};
                if (data.playlists) patch.playlists = data.playlists;
                if (data.settings && typeof data.settings === 'object') patch.librarySettings = data.settings;
                if (Object.keys(patch).length) this.update(patch);
                else await this.syncLibrary();
                return true;
            }
            return false;
        } catch (err) {
            console.error("Add to playlist error:", err);
            return false;
        }
    }

    async removeFromPlaylist(playlistName, trackId) {
        try {
            const res = await fetch(`${this.apiBase}/api/library/playlists/${encodeURIComponent(playlistName)}/tracks/${encodeURIComponent(trackId)}`, {
                method: 'DELETE'
            });
            if (res.ok) {
                const data = await res.json();
                const patch = {};
                if (data.playlists) patch.playlists = data.playlists;
                if (data.settings && typeof data.settings === 'object') patch.librarySettings = data.settings;
                if (Object.keys(patch).length) this.update(patch);
                else await this.syncLibrary();
                return true;
            }
            return false;
        } catch (err) {
            console.error("Remove from playlist error:", err);
            return false;
        }
    }

    async setPlaylistCover(playlistName, trackId) {
        try {
            const res = await fetch(`${this.apiBase}/api/library/playlists/${encodeURIComponent(playlistName)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    cover_track_id: trackId === null || trackId === undefined || trackId === '' ? null : String(trackId)
                })
            });
            if (res.ok) {
                const data = await res.json();
                const patch = {};
                if (data.playlists) patch.playlists = data.playlists;
                if (data.settings && typeof data.settings === 'object') patch.librarySettings = data.settings;
                if (Object.keys(patch).length) this.update(patch);
                else await this.syncLibrary();
                return true;
            }
            return false;
        } catch (err) {
            console.error('Set playlist cover error:', err);
            return false;
        }
    }

    async reorderPlaylistTracks(playlistName, trackIds) {
        try {
            const res = await fetch(`${this.apiBase}/api/library/playlists/${encodeURIComponent(playlistName)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ track_ids: trackIds })
            });
            if (res.ok) {
                const data = await res.json();
                const patch = {};
                if (data.playlists) patch.playlists = data.playlists;
                if (data.settings && typeof data.settings === 'object') patch.librarySettings = data.settings;
                if (Object.keys(patch).length) this.update(patch);
                else await this.syncLibrary();
                return true;
            }
            return false;
        } catch (err) {
            console.error("Reorder playlist tracks error:", err);
            return false;
        }
    }

    async duplicatePlaylist(sourceName, newName) {
        const ids = (this.state.playlists && this.state.playlists[sourceName]) || [];
        const ok = await this.createPlaylist(newName);
        if (!ok) return false;
        for (const trackId of ids) {
            await this.addToPlaylist(newName, trackId);
        }
        await this.syncLibrary();
        return true;
    }

    async reorderPlaylists(orderedNames) {
        try {
            const res = await fetch(`${this.apiBase}/api/library/playlists`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ order: orderedNames })
            });
            if (res.ok) {
                const data = await res.json();
                const patch = {};
                if (data.playlists) patch.playlists = data.playlists;
                if (data.settings && typeof data.settings === 'object') patch.librarySettings = data.settings;
                if (Object.keys(patch).length) this.update(patch);
                else await this.syncLibrary();
                return true;
            }
            return false;
        } catch (err) {
            console.error("Reorder playlists error:", err);
            return false;
        }
    }

    async updateMetadata(trackId, metadata, coverUrl = null) {
        try {
            const payload = { ...metadata };
            if (coverUrl) payload.cover_url = coverUrl;

            const res = await fetch(`${this.apiBase}/api/library/tracks/${trackId}/metadata`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            
            if (res.ok) {
                await this.syncLibrary();
                return true;
            }
            return false;
        } catch (err) {
            console.error("Metadata update error:", err);
            return false;
        }
    }

    async uploadCover(trackId, file) {
        try {
            const formData = new FormData();
            formData.append('file', file);

            const res = await fetch(`${this.apiBase}/api/library/tracks/${trackId}/cover`, {
                method: 'POST',
                body: formData
            });

            if (res.ok) {
                await this.syncLibrary();
                return true;
            }
            return false;
        } catch (err) {
            console.error("Cover upload error:", err);
            return false;
        }
    }

    async toggleQueue(trackId) {
        const isInQueue = this.state.queue.some(t => t.id === trackId);
        if (isInQueue) {
            return await this.removeFromQueueById(trackId);
        } else {
            return await this.addToQueue(trackId);
        }
    }

    async addToQueue(trackId) {
        try {
            const res = await fetch(`${this.apiBase}/api/playback/queue`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ track_id: trackId })
            });
            if (res.ok) {
                await this.syncQueue();
                return true;
            }
            return false;
        } catch (err) {
            console.error("Add to queue error:", err);
            return false;
        }
    }

    /**
     * Add a preview (Discover/Search) item to the playback queue.
     * @param {{ video_id?: string, id?: string, title?: string, artist?: string, duration?: number, duration_sec?: number, thumbnail?: string, library_track_id?: string, _libraryTrackId?: string }} item
     */
    async addPreviewToQueue(item) {
        if (!item) return false;
        const videoId = item.video_id ?? item.id;
        if (!videoId) return false;
        try {
            const preview = {
                video_id: videoId,
                title: item.title ?? 'Unknown',
                artist: item.artist ?? item.channel ?? '',
                duration: Number(item.duration ?? item.duration_sec ?? 0) || 0,
                thumbnail: item.thumbnail ?? null
            };
            if (item.library_track_id ?? item._libraryTrackId) {
                preview.library_track_id = item.library_track_id ?? item._libraryTrackId;
            }
            const res = await fetch(`${this.apiBase}/api/playback/queue`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ preview })
            });
            if (res.ok) {
                await this.syncQueue();
                return true;
            }
            return false;
        } catch (err) {
            console.error("Add preview to queue error:", err);
            return false;
        }
    }

    async removeFromQueueById(trackId) {
        try {
            const res = await fetch(`${this.apiBase}/api/playback/queue/track/${trackId}`, {
                method: 'DELETE'
            });
            if (res.ok) {
                await this.syncQueue();
                return true;
            }
            return false;
        } catch (err) {
            console.error("Remove from queue by ID error:", err);
            return false;
        }
    }

    async removeFromQueue(index) {
        try {
            const res = await fetch(`${this.apiBase}/api/playback/queue/${index}`, {
                method: 'DELETE'
            });
            if (res.ok) {
                await this.syncQueue();
                return true;
            }
            return false;
        } catch (err) {
            console.error("Remove from queue error:", err);
            return false;
        }
    }

    async reorderQueue(fromIndex, toIndex) {
        try {
            const res = await fetch(`${this.apiBase}/api/playback/queue/move`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ from_index: fromIndex, to_index: toIndex })
            });
            if (res.ok) {
                await this.syncQueue();
                return true;
            }
            return false;
        } catch (err) {
            console.error("Reorder queue error:", err);
            return false;
        }
    }

    async clearQueue() {
        try {
            const res = await fetch(`${this.apiBase}/api/playback/queue`, {
                method: 'DELETE'
            });
            if (res.ok) {
                await this.syncQueue();
                return true;
            }
            return false;
        } catch (err) {
            console.error("Clear queue error:", err);
            return false;
        }
    }

    /** Peek first track in queue without popping (for pre-buffering). */
    peekNextFromQueue() {
        const q = this.state.queue;
        return q && q.length > 0 ? q[0] : null;
    }

    async popNextFromQueue() {
        try {
            const res = await fetch(`${this.apiBase}/api/playback/next`);
            if (res.ok) {
                const track = await res.json();
                await this.syncQueue();
                return track;
            }
            return null;
        } catch (err) {
            console.error("Pop next error:", err);
            return null;
        }
    }

    importToken(token) {
        try {
            // Note: Decode token (Base64 -> zlib decompress -> JSON)
            // Note: In browser we use atob and pako or similar, but for now
            // Note: We assume the token is simple or handle basic JSON if plain text.
            
            // Note: For MVP, we will try to decode if it looks like Base64, else treat as JSON
            let data;
            try {
                const bin = atob(token);
                // Note: Simple check if it looks like binary, we might need a library.
                // Note: But if it was plain JSON-base64 we can read it.
                data = JSON.parse(bin);
            } catch {
                data = JSON.parse(token);
            }

            if (data.endpoints) {
                this.update({ priorityList: data.endpoints });
                this.save('priority_list', data.endpoints);
            }
            
            const nextConfig = { ...this.state.config, syncToken: token };
            this.save('config', nextConfig);
            this.update({ config: nextConfig });
            return true;
        } catch (e) {
            console.error("Token import failed:", e);
            return false;
        }
    }
}

export const store = new Store();
