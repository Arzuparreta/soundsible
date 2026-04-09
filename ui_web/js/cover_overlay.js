/**
 * Shared cover overlay helpers for mobile and desktop.
 */

export function createCoverOverlayController(options) {
    const { getOverlay, getImage, getBackdrop, getCloseButton, getFallbackCoverUrl } = options;

    const show = (coverUrl) => {
        const overlay = getOverlay();
        const image = getImage();
        if (!overlay || !image) return;
        const fallback = getFallbackCoverUrl();
        const url = (coverUrl || fallback).replace(/"/g, '%22').replace(/'/g, '%27');
        image.style.backgroundImage = `url("${url}")`;
        overlay.classList.remove('hidden');
    };

    const hide = () => {
        const overlay = getOverlay();
        if (overlay) overlay.classList.add('hidden');
    };

    const bind = () => {
        const overlay = getOverlay();
        const backdrop = getBackdrop();
        const closeButton = getCloseButton();
        if (!overlay) return;
        if (backdrop) backdrop.addEventListener('click', hide);
        if (closeButton) closeButton.addEventListener('click', hide);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) hide();
        });
    };

    return { show, hide, bind };
}
