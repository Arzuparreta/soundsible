/**
 * Connection Manager - Smart Resolver Engine
 * Handles multi-path probing and hot-swap connectivity.
 */
import { store } from './store.js';
import { isVisible, onChange as onVisibilityChange } from './visibility.js';

const RECONNECT_INTERVAL_VISIBLE_MS = 5000;
const RECONNECT_INTERVAL_HIDDEN_MS = 20000;

export class ConnectionManager {
    constructor() {
        this.timeout = 2500; // 2.5 seconds timeout per probe
    }

    /**
     * Pings all known endpoints and locks onto the fastest responder.
     * @param {string[]} endpoints - Array of hostnames or IPs.
     */
    async findActiveHost(endpoints) {
        if (!endpoints || endpoints.length === 0) return null;

        console.log("🚀 Starting Connection Race for:", endpoints);
        
        const probes = endpoints.map(host => this.probe(host));

        try {
            // Robust Promise.any fallback
            const fastestHost = await (Promise.any ? Promise.any(probes) : this._anyFallback(probes));
            console.log("✅ Fastest Path Locked:", fastestHost);
            
            // Update store
            store.update({ activeHost: fastestHost, isOnline: true });
            this.initSocket(fastestHost);
            return fastestHost;
        } catch (err) {
            console.error("❌ All connection paths failed.", err);
            store.update({ isOnline: false });
            return null;
        }
    }

    /**
     * Promise.any fallback for compatibility
     */
    _anyFallback(promises) {
        return new Promise((resolve, reject) => {
            let errors = [];
            promises.forEach(p => {
                Promise.resolve(p).then(resolve).catch(err => {
                    errors.push(err);
                    if (errors.length === promises.length) reject(new Error("All promises failed"));
                });
            });
        });
    }

    initSocket(host) {
        if (this.socket) {
            this.socket.disconnect();
        }

        console.log("🔌 Initializing SocketIO at:", host);
        this.socket = io(`http://${host}:5005`);

        this.socket.on('connect', () => {
            console.log("✅ Socket Connected");
            store.update({ isOnline: true });
            this.socket.emit('playback_register', {
                device_id: store.getDeviceId(),
                device_name: store.getDeviceName()
            });
        });

        this.socket.on('disconnect', () => {
            console.log("❌ Socket Disconnected");
            store.update({ isOnline: false });
            this.startReconnectionLoop();
        });

        // Forward downloader events to the window
        this.socket.on('downloader_log', (data) => {
            window.dispatchEvent(new CustomEvent('downloader_log', { detail: data }));
        });

        this.socket.on('downloader_update', (data) => {
            window.dispatchEvent(new CustomEvent('downloader_update', { detail: data }));
        });
        
        this.socket.on('library_updated', () => {
            store.syncLibrary();
        });

        this.socket.on('playback_stop_requested', () => {
            window.dispatchEvent(new CustomEvent('playback_stop_requested'));
        });
    }

    startReconnectionLoop() {
        if (this.reconnectInterval) return;

        const runProbe = async () => {
            if (store.state.isOnline) {
                this._clearReconnectLoop();
                return;
            }
            console.log("📡 Probing for Station Engine recovery...");
            const endpoints = [...store.state.priorityList, window.location.hostname];
            const uniqueEndpoints = [...new Set(endpoints)].filter(e => e);
            const success = await this.findActiveHost(uniqueEndpoints);
            if (success) {
                console.log("✨ Station Engine recovered!");
                store.syncLibrary();
                this._clearReconnectLoop();
            }
        };

        this._clearReconnectLoop = () => {
            if (this.reconnectInterval) {
                clearInterval(this.reconnectInterval);
                this.reconnectInterval = null;
            }
            if (this._unsubscribeVisibility) {
                this._unsubscribeVisibility();
                this._unsubscribeVisibility = null;
            }
        };

        const startInterval = () => {
            const ms = isVisible() ? RECONNECT_INTERVAL_VISIBLE_MS : RECONNECT_INTERVAL_HIDDEN_MS;
            this.reconnectInterval = setInterval(runProbe, ms);
        };

        console.log("🔄 Starting Reconnection Loop...");
        startInterval();

        this._unsubscribeVisibility = onVisibilityChange((visible) => {
            if (this.reconnectInterval) {
                clearInterval(this.reconnectInterval);
                this.reconnectInterval = null;
            }
            if (visible && !store.state.isOnline) runProbe();
            startInterval();
        });
    }

    async probe(host) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        
        const url = `http://${host}:5005/api/health`; // Check health endpoint
        
        try {
            const res = await fetch(url, { 
                method: 'GET', 
                signal: controller.signal,
                mode: 'cors'
            });
            clearTimeout(timeoutId);
            if (res.ok) return host;
            throw new Error("Offline");
        } catch (e) {
            throw e;
        }
    }
}

export const connectionManager = new ConnectionManager();
