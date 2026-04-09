/**
 * Shared view identifiers for mobile (UI.showView) and desktop (DesktopUI.showView).
 * Keeps navigation vocabulary aligned across shells.
 */
export const SHELL_VIEW_IDS = Object.freeze([
    'home',
    'favourites',
    'playlists',
    'playlist-detail',
    'artists',
    'artist-detail',
    'discover',
    'settings',
    'podcast'
]);

export function isShellViewId(id) {
    return typeof id === 'string' && SHELL_VIEW_IDS.includes(id);
}
