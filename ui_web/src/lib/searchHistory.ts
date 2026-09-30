import { createSignal } from 'solid-js';
import { userKey } from './session';

/**
 * The searches Discover remembers, and whether it remembers any at all.
 *
 * Search history is personal, and a browser profile can be shared by the whole
 * household — every key is namespaced by account so nobody reads anyone else's,
 * and turning it off is a choice that account makes for itself.
 */

export type SearchHistoryDomain = 'music' | 'youtube';

const RECENTS_KEY = 'catalog_search_recents';
const RECENTS_KEY_YOUTUBE = 'youtube_search_recents';
const ENABLED_KEY = 'search_history:enabled';
const LIMIT = 8;

// localStorage is not reactive; this is what tells readers it changed.
const [revision, bump] = createSignal(0);

function recentsKey(domain: SearchHistoryDomain): string {
  return userKey(domain === 'youtube' ? RECENTS_KEY_YOUTUBE : RECENTS_KEY);
}

/** Reactive: follows the switch in Settings and the signed-in account. */
export function searchHistoryEnabled(): boolean {
  revision();
  try {
    return localStorage.getItem(userKey(ENABLED_KEY)) !== 'off';
  } catch {
    return true;
  }
}

/**
 * Turning it off forgets what was already saved as well: a history that stops
 * growing but stays on the device is not what anyone means by "off".
 */
export function setSearchHistoryEnabled(enabled: boolean): void {
  try {
    if (enabled) {
      localStorage.removeItem(userKey(ENABLED_KEY));
    } else {
      localStorage.setItem(userKey(ENABLED_KEY), 'off');
      localStorage.removeItem(recentsKey('music'));
      localStorage.removeItem(recentsKey('youtube'));
    }
  } catch {
    /* Storage unavailable: nothing was saved to begin with. */
  }
  bump((n) => n + 1);
}

export function loadRecentSearches(domain: SearchHistoryDomain): string[] {
  if (!searchHistoryEnabled()) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(recentsKey(domain)) || '[]');
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string').slice(0, LIMIT) : [];
  } catch {
    return [];
  }
}

function saveRecentSearches(domain: SearchHistoryDomain, values: string[]): string[] {
  const next = values.slice(0, LIMIT);
  try {
    localStorage.setItem(recentsKey(domain), JSON.stringify(next));
  } catch {
    /* Session still shows it; it just will not survive a reload. */
  }
  return next;
}

/** Puts `query` first, once. Returns the list to show; saves nothing while off. */
export function rememberSearch(domain: SearchHistoryDomain, query: string): string[] {
  if (!searchHistoryEnabled()) return [];
  const current = loadRecentSearches(domain);
  return saveRecentSearches(domain, [
    query,
    ...current.filter((x) => x.toLowerCase() !== query.toLowerCase()),
  ]);
}

/** Removes one saved search. Returns the list to show. */
export function forgetSearch(domain: SearchHistoryDomain, query: string): string[] {
  return saveRecentSearches(
    domain,
    loadRecentSearches(domain).filter((x) => x !== query),
  );
}
