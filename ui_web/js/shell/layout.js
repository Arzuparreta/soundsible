/**
 * Responsive shell: layout breakpoint + optional redirect between /player/ and /player/desktop/.
 */
export const DESKTOP_MIN_WIDTH_PX = 1024;

export function prefersDesktopLayout() {
    return window.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH_PX}px)`).matches;
}

export function isDesktopPlayerRoute() {
    const p = window.location.pathname || '';
    return p.includes('/desktop') || /\/player\/desktop\/?$/i.test(p);
}

export function isMobilePlayerRoute() {
    return !isDesktopPlayerRoute();
}

/**
 * If viewport and route disagree, return URL to replace with.
 * Uses same origin; paths match Flask routes in shared/api/__init__.py.
 *
 * We only promote /player/ → /player/desktop/ on wide screens. We never strip
 * /player/desktop/ on narrow viewports: that URL is an explicit choice and must
 * keep the desktop shell (sidebar + layout), not the mobile omnibar.
 */
export function getShellRedirectUrl() {
    const wide = prefersDesktopLayout();
    const onDesktop = isDesktopPlayerRoute();
    if (wide && !onDesktop) {
        const u = new URL(window.location.href);
        u.pathname = '/player/desktop/';
        u.search = '';
        return u.toString();
    }
    return null;
}

export function subscribeLayoutChange(handler) {
    const mq = window.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH_PX}px)`);
    const fn = () => handler(prefersDesktopLayout());
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
}
