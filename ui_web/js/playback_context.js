/**
 * Shared playback context: resolve current track list and play from context.
 * Used by app.js (mobile) and app_desktop.js so only UI binding and view state source differ.
 */

import { store } from './store.js';
import { audioEngine } from './audio.js';
import * as renderers from './renderers.js';

/**
 * @param {string} currentView - 'home' | 'favourites' | 'playlists' | 'playlist-detail' | 'artist-detail' | 'discover'
 * @param {{ homeTracks?: unknown[]|null, favTracks?: unknown[]|null, artistTracks?: unknown[]|null, playlistTracks?: unknown[]|null, searchTracks?: unknown[]|null }} viewState
 * @returns {unknown[]}
 */
export function getCurrentTrackList(currentView, viewState) {
    const state = store.state;
    const library = state.library || [];
    const order = state.libraryOrder || 'date_added';
    const favorites = state.favorites || [];
    const sorted = () => renderers.sortLibraryTracks(library, order, favorites);

    if (currentView === 'home') return viewState.homeTracks != null ? viewState.homeTracks : sorted();
    if (currentView === 'favourites') return viewState.favTracks ?? library;
    if (currentView === 'playlists' || currentView === 'playlist-detail') return viewState.playlistTracks ?? library;
    if (currentView === 'artist-detail') return viewState.artistTracks ?? library;
    if (currentView === 'discover' && viewState.searchTracks) return viewState.searchTracks;
    return library;
}

/**
 * @param {string} trackId
 * @param {string} currentView
 * @param {Parameters<typeof getCurrentTrackList>[1]} viewState
 * @returns {unknown|null}
 */
export function getTrackFromContext(trackId, currentView, viewState) {
    const context = getCurrentTrackList(currentView, viewState);
    let track = context && context.find((t) => t.id === trackId);
    if (!track && store.state.queue) {
        track = store.state.queue.find((t) => t.id === trackId) || null;
    }
    return track || null;
}

/**
 * @param {string} trackId
 * @param {string} currentView
 * @param {Parameters<typeof getCurrentTrackList>[1]} viewState
 */
export function playTrackFromContext(trackId, currentView, viewState) {
    const context = getCurrentTrackList(currentView, viewState);
    let track = context && context.find((t) => t.id === trackId);
    let list = context;
    if (!track && store.state.queue) {
        track = store.state.queue.find((t) => t.id === trackId) || null;
        if (track) list = store.state.queue;
    }
    if (track) {
        audioEngine.setContext(list);
        store.update({ currentTrack: track });
        audioEngine.playTrack(track);
    }
}
