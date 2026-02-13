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
            return fastestHost;
        } catch (err) {
            console.error("❌ All connection paths failed.");
            store.update({ isOnline: false });
            return null;
        }
    }

    async probe(host) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        
        const url = `http://${host}:5005/`; // Check root API
        
        try {
            const res = await fetch(url, { 
                method: 'HEAD', 
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
