/**
 * Soundsible Downloader Manager
 */
import { store } from './store.js';

export class Downloader {
    static init() {
        if (this.initialized) return;
        this.initialized = true;

        this.input = document.getElementById('dl-input');
        this.addBtn = document.getElementById('dl-add-btn');
        this.startBtn = document.getElementById('dl-start-btn');
        this.clearBtn = document.getElementById('dl-clear-btn');
        this.queueList = document.getElementById('dl-queue-list');
        this.logs = document.getElementById('dl-logs');
        
        this.confClientId = document.getElementById('dl-conf-client-id');
        this.confClientSecret = document.getElementById('dl-conf-client-secret');
        this.confPath = document.getElementById('dl-conf-path');
        
        this.confR2Acc = document.getElementById('dl-conf-r2-acc');
        this.confR2Bucket = document.getElementById('dl-conf-r2-bucket');
        this.confR2Key = document.getElementById('dl-conf-r2-key');
        this.confR2Secret = document.getElementById('dl-conf-r2-secret');
        
        this.saveConfBtn = document.getElementById('dl-save-conf-btn');
        
        this.optimizeBtn = document.getElementById('dl-optimize-btn');
        this.syncBtn = document.getElementById('dl-sync-btn');
        
        this.spotifyList = document.getElementById('dl-spotify-playlists');
        this.refreshSpotifyBtn = document.getElementById('dl-refresh-spotify-btn');

        this.bindEvents();
        this.refreshStatus();
        this.loadConfig();
        this.loadSpotifyPlaylists();
        
        // Polling status if SocketIO isn't enough or for initial load
        setInterval(() => this.refreshStatus(), 5000);
    }

    static bindEvents() {
        this.addBtn.addEventListener('click', () => this.addToQueue());
        this.startBtn.addEventListener('click', () => this.startProcessing());
        this.clearBtn.addEventListener('click', () => this.clearQueue());
        this.saveConfBtn.addEventListener('click', () => this.saveConfig());
        this.refreshSpotifyBtn.addEventListener('click', () => this.loadSpotifyPlaylists());
        
        this.optimizeBtn.addEventListener('click', () => this.triggerOptimize());
        this.syncBtn.addEventListener('click', () => this.triggerSync());
        
        // Listen for global SocketIO events (assuming they are proxied through store or connection)
        window.addEventListener('downloader_log', (e) => this.addLog(e.detail.data));
        window.addEventListener('downloader_update', (e) => this.refreshStatus());

        // Also allow Enter key in input
        this.input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.addToQueue();
        });
    }

    static async addToQueue() {
        const lines = this.input.value.split('\n').map(l => l.trim()).filter(l => l);
        if (lines.length === 0) return;

        this.addBtn.disabled = true;
        this.addBtn.textContent = '...';

        try {
            const items = lines.map(line => ({ song_str: line }));
            const resp = await fetch(`${store.apiBase}/api/downloader/queue`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items })
            });
            
            const data = await resp.json();
            
            if (resp.ok) {
                this.input.value = '';
                await this.refreshStatus();
                this.addLog(`Queued ${lines.length} item(s).`);
                // Auto-trigger removed as per user request
            } else {
                alert(`Failed to add: ${data.message || 'Unknown error'}`);
            }
        } catch (err) {
            console.error("Queue failed:", err);
            alert("Could not reach Station. Check your connection.");
        } finally {
            this.addBtn.disabled = false;
            this.addBtn.textContent = 'Add to Queue';
        }
    }

    static async startProcessing() {
        try {
            await fetch(`${store.apiBase}/api/downloader/start`, { method: 'POST' });
            this.refreshStatus();
        } catch (err) {
            console.error("Start failed:", err);
        }
    }

    static async refreshStatus() {
        if (!store.state.activeHost) return;
        try {
            const resp = await fetch(`${store.apiBase}/api/downloader/queue/status`);
            const data = await resp.json();
            this.renderQueue(data.queue, data.is_processing);
            this.renderLogs(data.logs);
        } catch (err) {
            console.error("Status refresh failed:", err);
        }
    }

    static renderLogs(logs) {
        if (!logs || logs.length === 0) return;
        // Map logs to div elements and join
        // Station provides them in chronological order, we reverse to match UI's prepend style
        this.logs.innerHTML = [...logs].reverse().map(log => `<div>${log}</div>`).join('');
    }

    static async removeItem(id) {
        try {
            await fetch(`${store.apiBase}/api/downloader/queue/${id}`, { method: 'DELETE' });
            this.refreshStatus();
        } catch (err) {
            console.error("Remove failed:", err);
        }
    }

    static async clearQueue() {
        if (!confirm("Clear all items from the queue?")) return;
        try {
            await fetch(`${store.apiBase}/api/downloader/queue`, { method: 'DELETE' });
            this.refreshStatus();
        } catch (err) {
            console.error("Clear failed:", err);
        }
    }

    static renderQueue(queue, isProcessing) {
        if (!queue || queue.length === 0) {
            this.queueList.innerHTML = '<div class="text-center text-gray-500 mt-10 italic text-sm">Queue is empty</div>';
            return;
        }

        this.startBtn.textContent = isProcessing ? "Processing..." : "Start Processing";
        this.startBtn.className = isProcessing ? 
            "text-[10px] bg-blue-600 px-3 py-1 rounded-full text-white animate-pulse" : 
            "text-[10px] bg-green-600 hover:bg-green-700 px-3 py-1 rounded-full text-white";

        // Create a copy before reversing to avoid in-place flip on every poll
        const sortedQueue = [...queue].reverse();

        const html = sortedQueue.map(item => `
            <div class="bg-gray-900/50 p-3 rounded-xl border border-gray-700/50 flex items-center justify-between group">
                <div class="truncate flex-1 mr-4">
                    <div class="text-xs font-bold truncate">${item.song_str || 'Spotify Track'}</div>
                    <div class="text-[9px] text-gray-500 mt-0.5">${new Date(item.added_at).toLocaleString()}</div>
                </div>
                <div class="flex items-center space-x-2">
                    ${this.getStatusBadge(item.status)}
                    <button onclick="Downloader.removeItem('${item.id}')" class="p-2 text-gray-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100">
                        <i class="fas fa-trash text-[10px]"></i>
                    </button>
                </div>
            </div>
        `).join('');

        this.queueList.innerHTML = html;
    }

    static getStatusBadge(status) {
        const colors = {
            'pending': 'bg-gray-700 text-gray-400',
            'downloading': 'bg-blue-900/40 text-blue-400 animate-pulse',
            'completed': 'bg-green-900/40 text-green-400',
            'failed': 'bg-red-900/40 text-red-400'
        };
        return `<span class="text-[8px] uppercase font-black px-2 py-0.5 rounded-full ${colors[status] || 'bg-gray-700'}">${status}</span>`;
    }

    static addLog(msg) {
        const div = document.createElement('div');
        div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        this.logs.prepend(div);
        if (this.logs.children.length > 100) this.logs.lastChild.remove();
    }

    static async loadConfig() {
        if (!store.state.activeHost) return;
        try {
            const resp = await fetch(`${store.apiBase}/api/downloader/config`);
            const data = await resp.json();
            this.confClientId.value = data.spotify_client_id || '';
            this.confClientSecret.value = data.spotify_client_secret || '';
            this.confPath.value = data.output_dir || '';
            
            this.confR2Acc.value = data.r2_account_id || '';
            this.confR2Bucket.value = data.r2_bucket || '';
            this.confR2Key.value = data.r2_access_key || '';
            this.confR2Secret.value = data.r2_secret_key || '';
        } catch (err) {
            console.error("Config load failed:", err);
        }
    }

    static async saveConfig() {
        const data = {
            spotify_client_id: this.confClientId.value,
            spotify_client_secret: this.confClientSecret.value,
            output_dir: this.confPath.value,
            r2_account_id: this.confR2Acc.value,
            r2_bucket: this.confR2Bucket.value,
            r2_access_key: this.confR2Key.value,
            r2_secret_key: this.confR2Secret.value
        };

        try {
            const resp = await fetch(`${store.apiBase}/api/downloader/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            if (resp.ok) {
                this.addLog("Settings updated on Station.");
                this.loadConfig(); // Refresh to see masks
            }
        } catch (err) {
            console.error("Config save failed:", err);
        }
    }

    static async triggerOptimize() {
        const dryRun = confirm("Run Optimization in DRY RUN mode first? (Cancel for LIVE mode)");
        try {
            await fetch(`${store.apiBase}/api/downloader/optimize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dry_run: dryRun })
            });
            this.addLog(`Optimization started (${dryRun ? 'Dry Run' : 'LIVE'})...`);
        } catch (err) {
            console.error("Optimize failed:", err);
        }
    }

    static async triggerSync() {
        if (!confirm("Start syncing library to Cloud Storage?")) return;
        try {
            await fetch(`${store.apiBase}/api/downloader/sync`, { method: 'POST' });
            this.addLog("Cloud Sync started...");
        } catch (err) {
            console.error("Sync failed:", err);
        }
    }

    static async loadSpotifyPlaylists() {
        if (!store.state.activeHost) return;
        try {
            const resp = await fetch(`${store.apiBase}/api/downloader/spotify/playlists`);
            if (!resp.ok) {
                if (resp.status === 401) {
                    this.spotifyList.innerHTML = '<div class="col-span-full text-center py-10 text-gray-500 italic text-sm">Spotify not authenticated. Update settings below.</div>';
                }
                return;
            }
            const data = await resp.json();
            this.renderSpotifyPlaylists(data.playlists);
        } catch (err) {
            console.error("Spotify load failed:", err);
        }
    }

    static renderSpotifyPlaylists(playlists) {
        if (!playlists || playlists.length === 0) {
            this.spotifyList.innerHTML = '<div class="col-span-full text-center py-10 text-gray-500">No playlists found.</div>';
            return;
        }

        const html = playlists.map(p => `
            <div class="bg-gray-900 border border-gray-700 p-3 rounded-xl hover:bg-gray-700 cursor-pointer transition-colors group" onclick="Downloader.addSpotifyPlaylist('${p.id}', '${p.name.replace(/'/g, "\\'")}')">
                <div class="aspect-square bg-gray-800 rounded-lg mb-2 flex items-center justify-center overflow-hidden">
                    ${p.images && p.images[0] ? `<img src="${p.images[0].url}" class="w-full h-full object-cover">` : '<i class="fas fa-music text-gray-600"></i>'}
                </div>
                <div class="text-[10px] font-bold truncate">${p.name}</div>
                <div class="text-[8px] text-gray-500">${p.tracks.total} tracks</div>
            </div>
        `).join('');

        this.spotifyList.innerHTML = html;
        window.Downloader = Downloader; // Ensure it's globally accessible for onclick
    }

    static async addSpotifyPlaylist(id, name) {
        if (!confirm(`Add all tracks from "${name}" to download queue?`)) return;
        
        this.addLog(`Fetching tracks for playlist: ${name}...`);
        
        try {
            const resp = await fetch(`${store.apiBase}/api/downloader/queue`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    items: [{ type: 'playlist', id: id, song_str: `Playlist: ${name}`, spotify_data: { type: 'playlist', id: id } }] 
                })
            });
            if (resp.ok) {
                this.refreshStatus();
                this.addLog(`Queued playlist: ${name}`);
            }
        } catch (err) {
            console.error("Playlist queue failed:", err);
        }
    }
}
