/**
 * Single entry for mobile + desktop HTML shells: redirect when viewport disagrees with route, then boot app.
 */
import { getShellRedirectUrl, prefersDesktopLayout, subscribeLayoutChange, isDesktopPlayerRoute } from './shell/layout.js';

function boot() {
    const redirect = getShellRedirectUrl();
    if (redirect) {
        window.location.replace(redirect);
        return;
    }
    document.documentElement.dataset.layout = prefersDesktopLayout() ? 'wide' : 'narrow';
    document.documentElement.dataset.playerShell = isDesktopPlayerRoute() ? 'desktop' : 'mobile';

    subscribeLayoutChange(() => {
        const next = getShellRedirectUrl();
        if (next) window.location.replace(next);
    });

    if (isDesktopPlayerRoute()) {
        import('./app_desktop.js');
    } else {
        import('./app.js');
    }
}

boot();
