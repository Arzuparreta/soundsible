/**
 * Consumer desktop beta banner (DESIGN.md DT4).
 * Shown after first confirmed playback; dismissal persists in localStorage.
 */

const DISMISS_KEY = 'soundsible_beta_banner_dismissed_v1';

function isDismissed() {
    try {
        return localStorage.getItem(DISMISS_KEY) === '1';
    } catch (_) {
        return false;
    }
}

/** Wire dismiss control; safe to call on every desktop boot. */
export function initBetaBanner() {
    const banner = document.getElementById('desktop-beta-banner');
    const dismissBtn = document.getElementById('desktop-beta-dismiss');
    if (!banner || !dismissBtn) return;

    if (isDismissed()) {
        banner.classList.add('hidden');
        return;
    }

    dismissBtn.addEventListener('click', () => {
        try {
            localStorage.setItem(DISMISS_KEY, '1');
        } catch (_) {
            /* ignore */
        }
        banner.classList.add('hidden');
    });
}

/** Called when setup_first_play beacon fires (first eligible track in tab). */
export function showBetaBannerAfterFirstPlay() {
    if (isDismissed()) return;
    const banner = document.getElementById('desktop-beta-banner');
    if (!banner) return;
    banner.classList.remove('hidden');
}
