/**
 * Cross-device playback resume: check for other device state and show "Resume from {device}?" prompt.
 * Non-blocking: mobile = top notification-style banner; desktop = panel over sidebar logo.
 */
import { store } from './store.js';
import { audioEngine } from './audio.js';
import { Resolver } from './resolver.js';

const RESUME_STATE_TTL_SEC = 24 * 3600; // Note: 24H
const RESUME_DIALOG_COOLDOWN_MS = 30 * 60 * 1000; // Note: 30 Min
const RESUME_DIALOG_SUPPRESS_KEY = 'resume_dialog_suppress_until';
const RESUME_DIALOG_COOLDOWN_SET_AT_KEY = 'resume_dialog_cooldown_set_at';
const RESUME_SEEKED_FALLBACK_MS = 3000;
const RESUME_SYNC_PLAY_MAX_MS = 5000;
const RESUME_SYNC_SETTLE_MS = 1200;
const RESUME_MAX_WAIT_MS = 8000;
const RESUME_AFTER_PAUSE_MS = 150;
let resumeModalEl = null;
let outsideDismissBound = null;

function isMobile() {
    return typeof window !== 'undefined' && !window.location.pathname.includes('/desktop/');
}

function buildPanel(root) {
    const panel = document.createElement('div');
    panel.className = 'resume-playback-panel';
    const title = document.createElement('p');
    title.className = 'resume-playback-title';
    title.id = 'resume-playback-title';
    title.textContent = 'Resume playback';
    const deviceLabel = document.createElement('p');
    deviceLabel.className = 'resume-playback-device';
    deviceLabel.id = 'resume-playback-device';
    deviceLabel.setAttribute('aria-hidden', 'true');
    const btnWrap = document.createElement('div');
    btnWrap.className = 'resume-playback-actions';
    const noBtn = document.createElement('button');
    noBtn.type = 'button';
    noBtn.className = 'resume-playback-btn resume-playback-btn--secondary';
    noBtn.textContent = 'No';
    const yesBtn = document.createElement('button');
    yesBtn.type = 'button';
    yesBtn.className = 'resume-playback-btn resume-playback-btn--primary';
    yesBtn.textContent = 'Yes';
    panel.appendChild(title);
    panel.appendChild(deviceLabel);
    panel.appendChild(btnWrap);
    btnWrap.appendChild(noBtn);
    btnWrap.appendChild(yesBtn);

    noBtn.addEventListener('click', () => {
        setResumeDialogCooldown();
        hideResumeModal();
    });
    yesBtn.addEventListener('click', () => {
        const state = root._resumeState;
        if (state) onResumeYes(state);
        hideResumeModal();
    });
    return panel;
}

function onOutsideDismiss(e) {
    if (!resumeModalEl || resumeModalEl.classList.contains('hidden')) return;
    if (resumeModalEl.contains(e.target)) return;
    setResumeDialogCooldown();
    hideResumeModal();
}

function attachOutsideDismiss() {
    if (outsideDismissBound) return;
    outsideDismissBound = onOutsideDismiss;
    document.addEventListener('pointerdown', outsideDismissBound, true);
}

function detachOutsideDismiss() {
    if (!outsideDismissBound) return;
    document.removeEventListener('pointerdown', outsideDismissBound, true);
    outsideDismissBound = null;
}

function getResumeModal() {
    if (resumeModalEl) return resumeModalEl;
    const root = document.createElement('div');
    root.id = 'resume-playback-modal';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Resume playback');
    const panel = buildPanel(root);
    root.appendChild(panel);

    const desktop = !isMobile();
    if (desktop) {
        const logo = document.getElementById('desktop-body-logo');
        const sidebar = document.getElementById('desktop-sidebar');
        if (logo && sidebar && logo.parentNode) {
            const anchor = document.createElement('div');
            anchor.id = 'resume-playback-desktop-anchor';
            anchor.className = 'resume-playback-desktop-anchor';
            logo.parentNode.insertBefore(anchor, logo);
            anchor.appendChild(root);
            anchor.appendChild(logo);
            root.className = 'resume-playback-root resume-playback-root--desktop hidden';
        } else {
            root.className = 'resume-playback-root resume-playback-root--mobile hidden';
            document.body.appendChild(root);
        }
    } else {
        root.className = 'resume-playback-root resume-playback-root--mobile hidden';
        document.body.appendChild(root);
    }

    resumeModalEl = root;
    return root;
}

function setResumeDialogCooldown() {
    try {
        const now = Date.now();
        localStorage.setItem(RESUME_DIALOG_SUPPRESS_KEY, String(now + RESUME_DIALOG_COOLDOWN_MS));
        localStorage.setItem(RESUME_DIALOG_COOLDOWN_SET_AT_KEY, String(now));
    } catch (_) {}
}

function hideResumeModal() {
    if (resumeModalEl) {
        resumeModalEl.classList.add('hidden');
        resumeModalEl.classList.remove('resume-playback-root--open');
        resumeModalEl._resumeState = null;
        detachOutsideDismiss();
    }
}

function showResumeModal(state) {
    const modal = getResumeModal();
    const deviceName = state.device_name || state.device_id || 'other device';
    const titleEl = document.getElementById('resume-playback-title');
    const deviceEl = document.getElementById('resume-playback-device');
    if (titleEl) titleEl.textContent = 'Do you want to resume playback from ' + deviceName + '?';
    if (deviceEl) deviceEl.textContent = '';
    modal._resumeState = state;
    modal.classList.remove('hidden');
    requestAnimationFrame(() => {
        modal.classList.add('resume-playback-root--open');
    });
    attachOutsideDismiss();
}

function onResumeYes(state, opts = {}) {
    const isSameDevice = opts.isSameDevice === true;
    const trackId = state.track_id;
    const positionSec = Number(state.position_sec) || 0;
    const otherDeviceId = state.device_id;
    if (!trackId) return;
    const track = store.state.library.find(t => t.id === trackId);
    if (!track) return;
    // Note: Set resumeSyncActive before pause() so the pause listener does not flip isPlaying (same microtask ordering as fetch vs click).
    store.update({ resumeSyncActive: true });
    audioEngine.pause();
    const audio = audioEngine.audio;
    const savedVolumeAtStart = audio.volume;
    audio.volume = 0;
    store.update({ currentTrack: track, isPlaying: false, resumeSyncActive: true });
    const url = Resolver.getTrackUrl(track);
    audio.src = url;
    audio.load();

    // Note: Canplay → applyseek → seeked → sync-play (play to position, then pause) → complete.
    // Note: Mobile browsers often don't move decode on seek alone; playing does. same flow on all devices.
    let done = false;
    let fallbackTimeoutId = null;
    let maxWaitTimeoutId = null;
    let syncPlayTimeoutId = null;
    let syncTimeupdateBound = null;
    let afterPauseTimeoutId = null;
    const complete = () => {
        if (done) return;
        done = true;
        store.update({ resumeSyncActive: false });
        if (syncPlayTimeoutId) clearTimeout(syncPlayTimeoutId);
        syncPlayTimeoutId = null;
        if (syncTimeupdateBound) audio.removeEventListener('timeupdate', syncTimeupdateBound);
        syncTimeupdateBound = null;
        audio.removeEventListener('error', onError);
        audioEngine.pause();
        afterPauseTimeoutId = setTimeout(() => {
            afterPauseTimeoutId = null;
            audio.volume = savedVolumeAtStart;
            store.update({ isPlaying: false });
            if (!isSameDevice) {
                fetch(`${store.apiBase}/api/playback/notify-stop`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ device_id: otherDeviceId })
                }).catch(() => {});
                setResumeDialogCooldown();
            }
            store.pushPlaybackState(track.id, positionSec, false);
            store.syncQueue().catch(() => {});
        }, RESUME_AFTER_PAUSE_MS);
    };

    const startSeekedFallback = () => {
        if (fallbackTimeoutId) return;
        fallbackTimeoutId = setTimeout(complete, RESUME_SEEKED_FALLBACK_MS);
    };

    const applySeek = () => {
        const duration = audio.duration;
        if (!Number.isFinite(duration) || duration <= 0) return;
        audio.currentTime = Math.min(positionSec, duration);
        startSeekedFallback();
    };

    const onCanplay = () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
            applySeek();
        } else {
            audio.addEventListener('durationchange', function onDuration() {
                audio.removeEventListener('durationchange', onDuration);
                applySeek();
            }, { once: true });
        }
    };

    const finishSyncPlay = () => {
        if (done) return;
        if (syncPlayTimeoutId) clearTimeout(syncPlayTimeoutId);
        syncPlayTimeoutId = null;
        if (syncTimeupdateBound) audio.removeEventListener('timeupdate', syncTimeupdateBound);
        syncTimeupdateBound = null;
        complete();
    };

    const onSeeked = () => {
        const duration = audio.duration;
        if (!Number.isFinite(duration) || duration <= 0) {
            complete();
            return;
        }
        if (fallbackTimeoutId) clearTimeout(fallbackTimeoutId);
        fallbackTimeoutId = null;
        audio.currentTime = Math.min(positionSec, duration);
        audio.play().catch(finishSyncPlay);
        syncTimeupdateBound = () => {
            if (audio.currentTime >= positionSec - 0.5) {
                if (syncTimeupdateBound) audio.removeEventListener('timeupdate', syncTimeupdateBound);
                syncTimeupdateBound = null;
                if (syncPlayTimeoutId) clearTimeout(syncPlayTimeoutId);
                syncPlayTimeoutId = null;
                const d = audio.duration;
                if (Number.isFinite(d) && d > 0) audio.currentTime = Math.min(positionSec, d);
                syncPlayTimeoutId = setTimeout(finishSyncPlay, RESUME_SYNC_SETTLE_MS);
            }
        };
        audio.addEventListener('timeupdate', syncTimeupdateBound);
        syncPlayTimeoutId = setTimeout(finishSyncPlay, RESUME_SYNC_PLAY_MAX_MS);
    };

    const onError = () => {
        audio.removeEventListener('error', onError);
    };

    maxWaitTimeoutId = setTimeout(complete, RESUME_MAX_WAIT_MS);

    audio.addEventListener('canplay', onCanplay, { once: true });
    audio.addEventListener('seeked', onSeeked, { once: true });
    audio.addEventListener('error', onError, { once: true });
}

/**
 * Call after sync (library + queue) so we can resolve track_id. GETs playback state with exclude_device.
 * Same device: auto-restore track, position, queue (paused), only if the user has not started playback yet.
 * Other device: show "Resume from {device}?" prompt.
 */
export async function checkResumeFromOtherDevice() {
    const deviceId = store.getDeviceId();
    try {
        const res = await fetch(`${store.apiBase}/api/playback/state?exclude_device=${encodeURIComponent(deviceId)}`);
        // Note: User may have started playTrack while fetch was in flight (play event fires after await play resolves).
        if (store.hasUserPlaybackStarted()) return;
        if (res.status === 204 || res.status === 404) return;
        const state = await res.json();
        if (store.hasUserPlaybackStarted()) return;
        if (!state || !state.track_id) return;
        const updatedAt = Number(state.updated_at) || 0;
        if (updatedAt && (Date.now() / 1000 - updatedAt) > RESUME_STATE_TTL_SEC) return;

        if (state.device_id === deviceId) {
            // Note: Defer to a macrotask so pending input (play tap) runs before we read currentTrack / paused.
            // Note: Fetch microtasks can otherwise run before the click task and call onResumeYes while currentTrack is still null.
            setTimeout(() => {
                try {
                    if (store.hasUserPlaybackStarted()) return;
                    if (store.state.currentTrack != null) return;
                    try {
                        if (!audioEngine.audio.paused) return;
                    } catch (_) {}
                    if (store.state.resumeSyncActive) return;
                    onResumeYes(state, { isSameDevice: true });
                } catch (_) {}
            }, 0);
            return;
        }

        const now = Date.now();
        const suppressUntil = Number(localStorage.getItem(RESUME_DIALOG_SUPPRESS_KEY));
        const cooldownSetAt = Number(localStorage.getItem(RESUME_DIALOG_COOLDOWN_SET_AT_KEY));
        if (now >= suppressUntil) {
            showResumeModal(state);
            return;
        }
        if (Number.isFinite(cooldownSetAt) && (updatedAt * 1000) > cooldownSetAt) {
            showResumeModal(state);
            return;
        }
    } catch (_) {}
}
