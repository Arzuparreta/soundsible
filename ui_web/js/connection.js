/**
 * Connection Manager - Smart Resolver Engine
 * Handles multi-path probing and hot-swap connectivity.
 */
import { io } from './vendor/socket.io-client.esm.min.js';
import { store } from './store.js';
import { getApiBase } from './config.js';
import { isVisible, onChange as onVisibilityChange } from './visibility.js';
import { debugLog } from './debug.js';
// playback_resume.js is dynamically imported below to break a circular
// import chain (store -> connection -> playback_resume -> audio -> store).

const RECONNECT_INTERVAL_VISIBLE_MS = 5000;
const RECONNECT_INTERVAL_HIDDEN_MS = 20000;

// Reconnect/backoff spec (plan T5, Outside Voice #5):
//   - Socket.IO built-in reconnect: up to RECONNECT_ATTEMPTS tries with
//     1s → 5s backoff. On exhaustion the client falls back to the fetch-
//     probe loop in startReconnectionLoop() which keeps hitting
//     /api/health on every known endpoint.
//   - Each fresh initSocket() uses forceNew so Engine.IO assigns a new
//     sid — old session may be torn down server-side after ping_timeout.
//   - After RELOAD_AFTER_RECOVERIES successful re-establishments in a
//     single tab session, hard-reload as a last-resort escape hatch
//     against accumulated client-side state drift (stale store, leaked
//     listeners, etc.). Manual-restart-free 30-min Tailscale walk is the
//     gate this guards.
//   - Auth replay: the 'connect' handler re-emits playback_register on
//     every (re)connection, so device identity rides along with the new
//     sid without a separate auth round trip.
const SOCKET_RECONNECT_ATTEMPTS = 5;
const SOCKET_RECONNECT_DELAY_MS = 1000;
const SOCKET_RECONNECT_DELAY_MAX_MS = 5000;
const SOCKET_CONNECT_TIMEOUT_MS = 8000;
const RELOAD_AFTER_RECOVERIES = 3;

export class ConnectionManager {
    constructor() {
        this.timeout = 2500; // Note: 2.5 Seconds timeout per probe
        this.recoveryCount = 0;
    }

    /**
     * Pings all known endpoints and locks onto the fastest responder.
     * @param {string[]} endpoints - Array of hostnames or IPs.
     */
    async findActiveHost(endpoints) {
        if (!endpoints || endpoints.length === 0) return null;

        debugLog("Starting connection race for:", endpoints);
        
        const probes = endpoints.map(host => this.probe(host));

        try {
            // Note: Robust promise.any fallback
            const fastestHost = await (Promise.any ? Promise.any(probes) : this._anyFallback(probes));
            debugLog("Fastest path locked:", fastestHost);
            
            // ## Section: Update store
            store.update({ activeHost: fastestHost, isOnline: true });
            this.initSocket(fastestHost);
            return fastestHost;
        } catch (err) {
            console.error("All connection paths failed.", err);
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

        debugLog("Initializing SocketIO at:", host);
        this.socket = io(getApiBase(host), {
            // Force a new Manager so Engine.IO assigns a fresh sid — stale
            // sessions from before a Tailscale blip get cleanly discarded
            // server-side instead of triggering "invalid session" 400s.
            forceNew: true,
            reconnection: true,
            reconnectionAttempts: SOCKET_RECONNECT_ATTEMPTS,
            reconnectionDelay: SOCKET_RECONNECT_DELAY_MS,
            reconnectionDelayMax: SOCKET_RECONNECT_DELAY_MAX_MS,
            timeout: SOCKET_CONNECT_TIMEOUT_MS,
            transports: ['websocket', 'polling'],
        });

        this.socket.on('connect', () => {
            debugLog("Socket connected");
            store.update({ isOnline: true });
            const registration = {
                device_id: store.getDeviceId(),
                device_name: store.getDeviceName(),
                device_type: store.getDeviceType()
            };
            this.socket.emit('playback_register', registration);
            fetch(`${getApiBase(host)}/api/devices/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(registration)
            }).catch(() => {});
        });

        this.socket.on('disconnect', () => {
            debugLog("Socket disconnected");
            store.update({ isOnline: false });
            this.startReconnectionLoop();
        });

        // Note: Forward downloader events to the window
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

        this.socket.on('playback_start_requested', (data) => {
            window.dispatchEvent(new CustomEvent('playback_start_requested', { detail: data }));
        });

        this.socket.on('playback_next_requested', () => {
            window.dispatchEvent(new CustomEvent('playback_next_requested'));
        });

        this.socket.on('playback_previous_requested', () => {
            window.dispatchEvent(new CustomEvent('playback_previous_requested'));
        });

        this.socket.on('playback_seek_requested', (data) => {
            window.dispatchEvent(new CustomEvent('playback_seek_requested', { detail: data }));
        });
    }

    startReconnectionLoop() {
        if (this.reconnectInterval) return;

        const runProbe = async () => {
            if (store.state.isOnline) {
                this._clearReconnectLoop();
                return;
            }
            debugLog("Probing for Station Engine recovery...");
            const endpoints = [...store.state.priorityList, window.location.hostname];
            const uniqueEndpoints = [...new Set(endpoints)].filter(e => e);
            const success = await this.findActiveHost(uniqueEndpoints);
            if (success) {
                debugLog("Station Engine recovered");
                this.recoveryCount += 1;
                store.syncLibrary().then(async () => {
                    if (!store.hasUserPlaybackStarted() && store.state.currentTrack == null) {
                        const { checkResumeFromOtherDevice } = await import('./playback_resume.js');
                        checkResumeFromOtherDevice();
                    }
                });
                this._clearReconnectLoop();
                // Escape hatch: too many recoveries in one session usually
                // means accumulated client-state drift. Reload once to
                // reset, then let the user keep going.
                if (this.recoveryCount >= RELOAD_AFTER_RECOVERIES &&
                    typeof window !== 'undefined' && window.location) {
                    console.warn(`Forcing reload after ${this.recoveryCount} recoveries`);
                    window.location.reload();
                }
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

        debugLog("Starting reconnection loop...");
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
        
        const url = `${getApiBase(host)}/api/health`; // Note: Check health endpoint
        
        try {
            const res = await fetch(url, { 
                method: 'GET', 
                signal: controller.signal,
                mode: 'cors'
            });
            if (res.ok) return host;
            throw new Error("Offline");
        } finally {
            clearTimeout(timeoutId);
        }
    }
}

export const connectionManager = new ConnectionManager();
