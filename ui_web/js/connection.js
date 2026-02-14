/**
 * Connection Manager - Smart Resolver Engine
 * Handles multi-path probing and hot-swap connectivity.
 */
import { store } from './store.js';

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
            // Promise.any returns as soon as the first fetch succeeds
            const fastestHost = await Promise.any(probes);
            console.log("✅ Fastest Path Locked:", fastestHost);
            
            // Update store
            store.update({ activeHost: fastestHost, isOnline: true });
            this.initSocket(fastestHost);
            return fastestHost;
        } catch (err) {
            console.error("❌ All connection paths failed.");
            store.update({ isOnline: false });
            return null;
        }
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
    }

    startReconnectionLoop() {
        if (this.reconnectInterval) return;
        
        console.log("🔄 Starting Reconnection Loop...");
        this.reconnectInterval = setInterval(async () => {
            if (store.state.isOnline) {
                clearInterval(this.reconnectInterval);
                this.reconnectInterval = null;
                return;
            }

            console.log("📡 Probing for Station recovery...");
            const endpoints = [...store.state.priorityList, window.location.hostname];
            const uniqueEndpoints = [...new Set(endpoints)].filter(e => e);
            
            const success = await this.findActiveHost(uniqueEndpoints);
            if (success) {
                console.log("✨ Station Recovered!");
                store.syncLibrary();
                clearInterval(this.reconnectInterval);
                this.reconnectInterval = null;
            }
        }, 5000); // Try every 5 seconds
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
