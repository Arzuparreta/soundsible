/**
 * Pointer-driven seek bars (omni, now-playing, desktop bar).
 */
import { audioEngine } from './audio.js';

export function calculateSeekPercent(e, container) {
    const rect = container.getBoundingClientRect();
    const clientX = e.clientX ?? e.changedTouches?.[0]?.clientX ?? e.touches?.[0]?.clientX;
    if (clientX == null) return null;
    const x = clientX - rect.left;
    return Math.max(0, Math.min(100, (x / rect.width) * 100));
}

const SEEK_THROTTLE_MS = 50;

/**
 * @param {HTMLElement} container
 * @param {HTMLElement|null} progressBarEl
 * @param {object} [opts]
 * @param {object} [opts.audioEngine] default audioEngine
 * @param {{ current: boolean }} [opts.dragRef]
 * @param {() => boolean} [opts.onPointerDownGuard]
 * @param {{ last: number }} [opts.durationState] mutated: .last = last known duration seconds
 * @param {(pct: number, currentTime: number, duration: number) => void} [opts.onScrub]
 */
export function attachSeekBar(container, progressBarEl, opts = {}) {
    const {
        audioEngine: engine = audioEngine,
        dragRef,
        onPointerDownGuard = () => true,
        durationState,
        onScrub
    } = opts;

    let isDragging = false;
    let dragPointerId = null;
    let hasDragged = false;

    const applyScrub = (pct) => {
        if (!onScrub) return;
        const dur = durationState?.last ?? 0;
        onScrub(pct, (pct / 100) * dur, dur);
    };

    const onStart = (e) => {
        if (isDragging) return;
        if (!onPointerDownGuard()) return;
        e.preventDefault();
        e.stopPropagation();
        isDragging = true;
        if (dragRef) dragRef.current = true;
        hasDragged = false;
        dragPointerId = e.pointerId;
        container.setPointerCapture(e.pointerId);
        container.classList.add('seeking');
        const pct = calculateSeekPercent(e, container);
        if (pct != null && progressBarEl) {
            progressBarEl.style.transition = 'none';
            progressBarEl.style.width = `${pct}%`;
        }
        if (pct != null) applyScrub(pct);
    };
    const onMove = (e) => {
        if (!isDragging || e.pointerId !== dragPointerId) return;
        e.preventDefault();
        e.stopPropagation();
        hasDragged = true;
        const pct = calculateSeekPercent(e, container);
        if (pct != null && progressBarEl) {
            progressBarEl.style.width = `${pct}%`;
            if (!container._lastSeekTime || Date.now() - container._lastSeekTime > SEEK_THROTTLE_MS) {
                engine.seek(pct);
                container._lastSeekTime = Date.now();
            }
        }
        if (pct != null) applyScrub(pct);
    };
    const onEnd = (e) => {
        if (!isDragging || e.pointerId !== dragPointerId) return;
        e.preventDefault();
        e.stopPropagation();
        const wasDragging = hasDragged;
        isDragging = false;
        if (dragRef) dragRef.current = false;
        dragPointerId = null;
        try {
            container.releasePointerCapture(e.pointerId);
        } catch {
            /* already released */
        }
        container.classList.remove('seeking');
        const pct = calculateSeekPercent(e, container);
        if (pct != null) {
            engine.seek(pct);
            if (progressBarEl) progressBarEl.style.transition = '';
        }
        if (wasDragging) setTimeout(() => { hasDragged = false; }, 100);
    };
    container.addEventListener('pointerdown', onStart);
    container.addEventListener('pointermove', onMove);
    container.addEventListener('pointerup', onEnd);
    container.addEventListener('pointercancel', onEnd);
    container.addEventListener('click', (e) => {
        if (!hasDragged) {
            const pct = calculateSeekPercent(e, container);
            if (pct != null) engine.seek(pct);
        }
    });
}

/**
 * @param {object} opts
 * @param {{ last: number }} [opts.durationState]
 * @param {(pct: number) => void} [opts.onAnnounce]
 */
export function bindSeekSliderKeys(container, progressBarEl, opts = {}) {
    const {
        audioEngine: engine = audioEngine,
        durationState,
        dragRef,
        onScrub,
        onAnnounce
    } = opts;

    const step = (deltaPct) => {
        if (dragRef?.current) return;
        const dur =
            (durationState?.last && durationState.last > 0)
                ? durationState.last
                : (Number.isFinite(engine.audio?.duration) && engine.audio.duration > 0 ? engine.audio.duration : 0);
        if (dur <= 0) return;
        let curPct = 0;
        if (Number.isFinite(engine.audio?.duration) && engine.audio.duration > 0) {
            curPct = (engine.audio.currentTime / engine.audio.duration) * 100;
        } else if (progressBarEl?.style?.width) {
            const m = String(progressBarEl.style.width).match(/([\d.]+)/);
            if (m) curPct = parseFloat(m[1]);
        }
        const next = Math.max(0, Math.min(100, curPct + deltaPct));
        if (progressBarEl) {
            progressBarEl.style.transition = 'none';
            progressBarEl.style.width = `${next}%`;
            progressBarEl.style.transition = '';
        }
        engine.seek(next);
        if (onScrub) onScrub(next, (next / 100) * dur, dur);
        if (onAnnounce) onAnnounce(next);
    };

    container.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            step(-2);
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            step(2);
        } else if (e.key === 'Home') {
            e.preventDefault();
            step(-100);
        } else if (e.key === 'End') {
            e.preventDefault();
            step(100);
        }
    });
}
