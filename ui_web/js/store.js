/**
 * State Management Store
 */
import { connectionManager } from './connection.js';

class Store {
    constructor() {
        this.state = {
            config: this.load('config', {
                host: window.location.hostname || 'localhost',
                port: 5005,
                syncToken: null
            }),
            priorityList: this.load('priority_list', []),
            activeHost: window.location.hostname || 'localhost',
            isOnline: true,
            library: this.load('library', []),
            favorites: this.load('favorites', []),
            playlists: this.load('playlists', {}),
            queue: [],
            repeatMode: 'off', // off, all, one
            shuffleEnabled: false,
            currentTrack: null,
            isPlaying: false,
            theme: (() => {
                const t = this.load('theme', 'dark');
                return ['dark', 'light', 'odst'].includes(t) ? t : 'dark';
            })(),
            hapticsEnabled: this.load('haptics', true),
            libraryOrder: this.load('library_order', 'date_added'),
            songsViewMode: (() => { const v = this.load('songs_view_mode', 'list'); const valid = ['list', 'grid', 'gridCompact', 'gridLarge']; return valid.includes(v) ? v : (v === 'gridXLarge' ? 'gridLarge' : 'list'); })(),
            artistViewMode: (() => { const v = this.load('artist_view_mode', 'gridCompact'); const valid = ['gridCompact', 'grid', 'gridLarge']; return valid.includes(v) ? v : (v === 'gridXLarge' ? 'gridLarge' : 'gridCompact'); })()
        };
        this.subscribers = [];
        this.applyTheme(this.state.theme);
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
        localStorage.setItem(`soundsible_${key}`, JSON.stringify(val));
    }

    update(patch) {
        let changed = false;
        for (const key in patch) {
            // Shallow equality check for primitive values (status, isPlaying, etc)
            if (this.state[key] !== patch[key]) {
                changed = true;
                break;
            }
        }
        
        if (!changed) return;

        this.state = { ...this.state, ...patch };
        if (patch.libraryOrder !== undefined) this.save('library_order', patch.libraryOrder);
        if (patch.songsViewMode !== undefined) this.save('songs_view_mode', patch.songsViewMode);
        if (patch.artistViewMode !== undefined) this.save('artist_view_mode', patch.artistViewMode);
        if (patch.playlists !== undefined) this.save('playlists', patch.playlists);
        console.log("State Update:", Object.keys(patch));
        this.subscribers.forEach(cb => cb(this.state));
    }

    subscribe(cb) {
        this.subscribers.push(cb);
        return () => {
            this.subscribers = this.subscribers.filter(s => s !== cb);
        };
    }

    get apiBase() {
        return `http://${this.state.activeHost}:5005`;
    }

    async syncLibrary() {
        const host = this.state.activeHost;
        const port = this.state.config.port;
        const url = `http://${host}:${port}/api/library?t=${Date.now()}`;
        
        try {
            console.log(`Syncing with ${url}...`);
            const res = await fetch(url);
            if (!res.ok) throw new Error("Sync failed");
            
            const data = await res.json();

            // Also sync favourites and queue
            await this.syncFavourites();
            await this.syncQueue();

            const playlists = data.playlists && typeof data.playlists === 'object' ? data.playlists : {};
            this.update({ library: data.tracks, playlists, isOnline: true });
            this.save('library', data.tracks);
            this.save('playlists', playlists);
            return true;
        } catch (err) {
            console.error("Library sync error:", err);
            this.update({ isOnline: false });
            connectionManager.startReconnectionLoop();
            return false;
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
                this.update({ 
                    queue: data.tracks,
                    repeatMode: data.repeat_mode
                });
            }
        } catch (err) {
            console.error("Queue sync error:", err);
        }
    }

    async toggleShuffle() {
        try {
            const res = await fetch(`${this.apiBase}/api/playback/shuffle`, { method: 'POST' });
            if (res.ok) {
                this.update({ shuffleEnabled: !this.state.shuffleEnabled });
                await this.syncQueue();
                return true;
            }
            return false;
        } catch (err) {
            console.error("Shuffle error:", err);
            return false;
        }
    }

    async toggleRepeat() {
        const modes = ['off', 'all', 'one'];
        const nextMode = modes[(modes.indexOf(this.state.repeatMode) + 1) % modes.length];
        
        try {
            const res = await fetch(`${this.apiBase}/api/playback/repeat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: nextMode })
            });
            if (res.ok) {
                this.update({ repeatMode: nextMode });
                return true;
            }
            return false;
        } catch (err) {
            console.error("Repeat toggle error:", err);
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
                console.log("✓ Track deleted from Station");
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
                if (data.playlists) {
                    this.update({ playlists: data.playlists });
                    this.save('playlists', data.playlists);
                } else await this.syncLibrary();
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
                if (data.playlists) {
                    this.update({ playlists: data.playlists });
                    this.save('playlists', data.playlists);
                } else await this.syncLibrary();
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
                if (data.playlists) {
                    this.update({ playlists: data.playlists });
                    this.save('playlists', data.playlists);
                } else await this.syncLibrary();
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
                if (data.playlists) {
                    this.update({ playlists: data.playlists });
                    this.save('playlists', data.playlists);
                } else await this.syncLibrary();
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
                if (data.playlists) {
                    this.update({ playlists: data.playlists });
                    this.save('playlists', data.playlists);
                } else await this.syncLibrary();
                return true;
            }
            return false;
        } catch (err) {
            console.error("Remove from playlist error:", err);
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
                if (data.playlists) {
                    this.update({ playlists: data.playlists });
                    this.save('playlists', data.playlists);
                } else await this.syncLibrary();
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
                if (data.playlists) {
                    this.update({ playlists: data.playlists });
                    this.save('playlists', data.playlists);
                } else await this.syncLibrary();
                return true;
            }
            return false;
        } catch (err) {
            console.error("Reorder playlists error:", err);
            return false;
        }
    }

    async searchMetadata(query) {
        try {
            const res = await fetch(`${this.apiBase}/api/metadata/search?q=${encodeURIComponent(query)}`);
            if (res.ok) {
                return await res.json();
            }
            return [];
        } catch (err) {
            console.error("Metadata search error:", err);
            return [];
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
            // Decode token (Base64 -> Zlib Decompress -> JSON)
            // Note: In browser we use atob and pako or similar, but for now 
            // we assume the token is simple or handle basic JSON if plain text.
            
            // For MVP, we will try to decode if it looks like Base64, else treat as JSON
            let data;
            try {
                const bin = atob(token);
                // Simple check: if it looks like binary, we might need a library. 
                // But if it was plain json-base64 we can read it.
                data = JSON.parse(bin);
            } catch {
                data = JSON.parse(token);
            }

            if (data.endpoints) {
                this.update({ priorityList: data.endpoints });
                this.save('priority_list', data.endpoints);
            }
            
            this.state.config.syncToken = token;
            this.save('config', this.state.config);
            this.update({ config: this.state.config });
            return true;
        } catch (e) {
            console.error("Token import failed:", e);
            return false;
        }
    }
}

export const store = new Store();
