import { afterEach, describe, expect, it } from 'vitest';
import {
  forgetSearch,
  loadRecentSearches,
  rememberSearch,
  searchHistoryEnabled,
  setSearchHistoryEnabled,
} from './searchHistory';

afterEach(() => {
  setSearchHistoryEnabled(true);
  localStorage.clear();
});

describe('search history', () => {
  it('keeps the newest search first, once, per domain', () => {
    rememberSearch('music', 'Marea');
    rememberSearch('music', 'Extremoduro');
    expect(rememberSearch('music', 'marea')).toEqual(['marea', 'Extremoduro']);
    expect(loadRecentSearches('youtube')).toEqual([]);
  });

  it('forgets one search and leaves the rest', () => {
    rememberSearch('music', 'Marea');
    rememberSearch('music', 'Extremoduro');
    expect(forgetSearch('music', 'Marea')).toEqual(['Extremoduro']);
    expect(loadRecentSearches('music')).toEqual(['Extremoduro']);
  });

  it('turning it off deletes what was saved and saves nothing more', () => {
    rememberSearch('music', 'Marea');
    rememberSearch('youtube', 'live session');
    setSearchHistoryEnabled(false);
    expect(searchHistoryEnabled()).toBe(false);
    expect(rememberSearch('music', 'Extremoduro')).toEqual([]);
    setSearchHistoryEnabled(true);
    expect(loadRecentSearches('music')).toEqual([]);
    expect(loadRecentSearches('youtube')).toEqual([]);
  });
});
