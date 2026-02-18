/**
 * Haptics Engine - Soundsible 'Cyber-Premium' Tactile Feedback
 * 
 * Provides a centralized API for high-fidelity vibration patterns.
 * Designed for battery efficiency and system silent mode compatibility.
 */
import { store } from './store.js';

export class Haptics {
    // Tactile Vocabulary (durations in ms)
    static PATTERNS = {
        TICK: [5],
        LOCK: [15],
        HEAVY: [30],
        SUCCESS: [10, 50, 10],
        ERROR: [50, 50, 50]
    };

    /**
     * Triggers a haptic pulse if enabled in settings.
     * Native OS behavior handles silent/DND mode compliance.
     * @param {number|number[]} pattern - Duration or array of [vibrate, pause, ...]
     */
    static trigger(pattern) {
        if (!store.state.hapticsEnabled) {
            console.log("Haptics: Disabled in settings.");
            return;
        }
        
        try {
            if ('vibrate' in navigator) {
                const result = navigator.vibrate(pattern);
                console.log(`Haptics: Triggered [${pattern}] -> Success: ${result}`);
            } else {
                console.warn("Haptics: navigator.vibrate not supported on this device.");
            }
        } catch (err) {
            console.warn("Haptics: Interaction failed or blocked by browser policy.", err);
        }
    }

    // Semantic Aliases
    static tick() { this.trigger(this.PATTERNS.TICK); }
    static lock() { this.trigger(this.PATTERNS.LOCK); }
    static heavy() { this.trigger(this.PATTERNS.HEAVY); }
    static success() { this.trigger(this.PATTERNS.SUCCESS); }
    static error() { this.trigger(this.PATTERNS.ERROR); }
}
