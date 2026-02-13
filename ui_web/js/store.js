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

    async syncLibrary() {
        const { host, port } = this.state.config;
        const url = `http://${host}:${port}/api/library`;
        
        try {
            console.log(`Syncing with ${url}...`);
            const res = await fetch(url);
            if (!res.ok) throw new Error("Sync failed");
            
            const data = await res.json();
            this.update({ library: data.tracks });
            this.save('library', data.tracks);
            return true;
        } catch (err) {
            console.error("Library sync error:", err);
            return false;
        }
    }

    importToken(token) {
        try {
            // Placeholder: Parse token if we implement the same encryption/decryption in JS
            // For now, assume token contains direct config or we just store it
            this.state.config.syncToken = token;
            this.save('config', this.state.config);
            this.update({ config: this.state.config });
            return true;
        } catch (e) {
            return false;
        }
    }
}

export const store = new Store();
