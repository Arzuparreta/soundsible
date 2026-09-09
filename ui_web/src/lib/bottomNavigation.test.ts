import { describe, expect, it } from 'vitest';
import { resolveBottomNavigation, setBottomNavigation, bottomNavigation } from './bottomNavigation';
import { defaultBottomNavigation } from '../components/primaryNavigation';
describe('bottom navigation preference', () => {
  it.each([null, {}, [], ['/', '/', '/search'], ['/', '/unknown', '/settings'], ['/', '/search'], ['/', '/search', '/settings', '/live', '/downloads', '/podcasts']])('recovers invalid persisted configuration %j', value => {
    expect(resolveBottomNavigation(value)).toEqual(defaultBottomNavigation);
  });
  it('persists a custom order without requiring Library or Settings', () => {
    const custom = ['/live', '/podcasts', '/downloads'];
    setBottomNavigation(custom);
    expect(bottomNavigation()).toEqual(custom);
    expect(JSON.parse(localStorage.getItem('navigation:bottom')!)).toEqual(custom);
    setBottomNavigation(defaultBottomNavigation);
  });
});
