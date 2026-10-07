import { beforeEach, expect, it } from 'vitest';
import { createSearchHistoryStorage } from './searchHistoryStorage';
beforeEach(() => localStorage.clear());
it('separates equal account IDs on different stations and follows account changes', () => {
  let origin = 'https://one.test', id = 'member';
  const history = createSearchHistoryStorage(key => JSON.stringify([origin, id, key]));
  history.remember('music', 'First station');
  origin = 'https://two.test';
  expect(history.load('music')).toEqual([]);
  history.remember('music', 'Second station');
  id = 'owner';
  expect(history.load('music')).toEqual([]);
  id = 'member'; origin = 'https://one.test';
  expect(history.load('music')).toEqual(['First station']);
});
it('turning history off forgets both domains only for its own profile', () => {
  const first = createSearchHistoryStorage(key => `first:${key}`);
  const second = createSearchHistoryStorage(key => `second:${key}`);
  first.remember('music', 'Song'); first.remember('youtube', 'Video');
  second.remember('music', 'Other song');
  first.setEnabled(false);
  expect(first.enabled()).toBe(false);
  expect(first.load('music')).toEqual([]); expect(first.load('youtube')).toEqual([]);
  expect(first.remember('music', 'Hidden')).toEqual([]);
  expect(second.load('music')).toEqual(['Other song']);
  first.setEnabled(true); expect(first.load('music')).toEqual([]);
});
