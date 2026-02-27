/**
 * Cross-device playback resume: check for other device state and show "Resume from {device}?" dialog.
 * Shared by mobile and desktop.
 */
import { store } from './store.js';
import { audioEngine } from './audio.js';
import { Resolver } from './resolver.js';

const RESUME_STATE_TTL_SEC = 24 * 3600; // 24h
const RESUME_DIALOG_COOLDOWN_MS = 30 * 60 * 1000; // 30 min
const RESUME_DIALOG_SUPPRESS_KEY = 'resume_dialog_suppress_until';
const RESUME_DIALOG_COOLDOWN_SET_AT_KEY = 'resume_dialog_cooldown_set_at';
const RESUME_SEEKED_FALLBACK_MS = 3000;
const RESUME_SYNC_PLAY_MAX_MS = 5000;
const RESUME_SYNC_SETTLE_MS = 1200;
const RESUME_MAX_WAIT_MS = 8000;
const RESUME_AFTER_PAUSE_MS = 150;
const RESUME_MODAL_LOCK_CLASS = 'resume-modal-lock';
let resumeModalEl = null;

function isMobile() {
    return typeof window !== 'undefined' && !window.location.pathname.includes('/desktop/');
}

function getResumeModal() {
    if (resumeModalEl) return resumeModalEl;
    const overlay = document.createElement('div');
    overlay.id = 'resume-playback-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Resume playback');
    overlay.className = 'fixed inset-0 z-[150] hidden flex items-center justify-center p-4';
    overlay.style.cssText = 'background-color: var(--overlay-bg, rgba(0,0,0,0.5)); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);';
    const panel = document.createElement('div');
    panel.className = 'rounded-2xl p-6 max-w-sm w-full shadow-xl';
    panel.style.cssText = 'background: rgba(255,255,255,0.08); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.12);';
    const title = document.createElement('p');
    title.className = 'text-base font-medium text-[var(--text)] mb-2';
    title.id = 'resume-playback-title';
    title.textContent = 'Resume playback';
    const deviceLabel = document.createElement('p');
    deviceLabel.className = 'text-sm text-[var(--text-dim)] mb-4';
    deviceLabel.id = 'resume-playback-device';
    const btnWrap = document.createElement('div');
    btnWrap.className = 'flex gap-3 justify-end';
    const noBtn = document.createElement('button');
    noBtn.type = 'button';
    noBtn.className = 'px-4 py-2 rounded-xl text-sm font-medium opacity-80 hover:opacity-100 transition-opacity';
    noBtn.textContent = 'No';
    noBtn.style.color = 'var(--text-dim)';
    const yesBtn = document.createElement('button');
    yesBtn.type = 'button';
    yesBtn.className = 'px-4 py-2 rounded-xl text-sm font-medium bg-[var(--accent)] text-white hover:opacity-90 transition-opacity';
    yesBtn.textContent = 'Yes';
    panel.appendChild(title);
    panel.appendChild(deviceLabel);
    panel.appendChild(btnWrap);
    btnWrap.appendChild(noBtn);
    btnWrap.appendChild(yesBtn);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (e) => {
        if (!panel.contains(e.target)) {
            setResumeDialogCooldown();
            hideResumeModal();
        }
    });
    noBtn.addEventListener('click', () => {
        setResumeDialogCooldown();
        hideResumeModal();
    });
    yesBtn.addEventListener('click', () => {
        const state = overlay._resumeState;
        if (state) onResumeYes(state);
        hideResumeModal();
    });
    resumeModalEl = overlay;
    document.body.appendChild(overlay);
    return overlay;
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
        resumeModalEl._resumeState = null;
        if (isMobile()) document.body.classList.remove(RESUME_MODAL_LOCK_CLASS);
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
    modal.classList.add('flex');
    if (isMobile()) document.body.classList.add(RESUME_MODAL_LOCK_CLASS);
}

function onResumeYes(state, opts = {}) {
    const isSameDevice = opts.isSameDevice === true;
    const trackId = state.track_id;
    const positionSec = Number(state.position_sec) || 0;
    const otherDeviceId = state.device_id;
    if (!trackId) return;
    const track = store.state.library.find(t => t.id === trackId);
    if (!track) return;
    audioEngine.pause();
    const audio = audioEngine.audio;
    const savedVolumeAtStart = audio.volume;
    audio.volume = 0;
    store.update({ currentTrack: track, isPlaying: false, resumeSyncActive: true });
    const url = Resolver.getTrackUrl(track);
    audio.src = url;
    audio.load();

    // canplay → applySeek → seeked → sync-play (play to position, then pause) → complete.
    // Mobile browsers often don't move decode on seek alone; playing does. Same flow on all devices.
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
 * Same device: auto-restore track, position, queue (paused). Other device: show "Resume from {device}?" dialog.
 */
export async function checkResumeFromOtherDevice() {
    const deviceId = store.getDeviceId();
    try {
        const res = await fetch(`${store.apiBase}/api/playback/state?exclude_device=${encodeURIComponent(deviceId)}`);
        if (res.status === 204 || res.status === 404) return;
        const state = await res.json();
        if (!state || !state.track_id) return;
        const updatedAt = Number(state.updated_at) || 0;
        if (updatedAt && (Date.now() / 1000 - updatedAt) > RESUME_STATE_TTL_SEC) return;

        if (state.device_id === deviceId) {
            onResumeYes(state, { isSameDevice: true });
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
