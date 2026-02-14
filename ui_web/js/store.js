/**
 * State Management Store
 */

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
            queue: [],
            currentTrack: null,
            isPlaying: false
        };
        this.subscribers = [];
    }

    load(key, fallback) {
        const data = localStorage.getItem(`soundsible_${key}`);
        return data ? JSON.parse(data) : fallback;
    }

    save(key, val) {
        localStorage.setItem(`soundsible_${key}`, JSON.stringify(val));
    }

    update(patch) {
        let changed = false;
        for (const key in patch) {
            if (JSON.stringify(this.state[key]) !== JSON.stringify(patch[key])) {
                changed = true;
                break;
            }
        }
        
        if (!changed) return;

        this.state = { ...this.state, ...patch };
        console.log("State Update:", patch);
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
        const url = `http://${host}:${port}/api/library`;
        
        try {
            console.log(`Syncing with ${url}...`);
            const res = await fetch(url);
            if (!res.ok) throw new Error("Sync failed");
            
            const data = await res.json();
            this.update({ library: data.tracks, isOnline: true });
            this.save('library', data.tracks);
            return true;
        } catch (err) {
            console.error("Library sync error:", err);
            this.update({ isOnline: false });
            return false;
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
