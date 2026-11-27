import { expect, test, type Page } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';

/**
 * The Live broadcast bridge, its client and WebRTC used to ship with the first
 * library paint of every session. They are fetched only once Live is in use
 * (lib/communityGate): when a hosted room is waiting to be resumed, or when
 * something imports lib/community.
 */
const liveModules = (page: Page) => {
  const seen: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (/CommunityBridge|lib\/community(Webrtc)?\.ts/.test(path)) seen.push(path);
  });
  return seen;
};

test('a session that never opens Live does not load the broadcast bridge', async ({ page }) => {
  const seen = liveModules(page);
  await mockMusicEngine(page);
  await page.goto('/player/#/songs');
  await expect(page.getByRole('button', { name: /Reproducir Canción de biblioteca 320/ })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(seen).toEqual([]);
});

test('a stored hosted room loads the bridge at boot so the broadcast can resume', async ({ page }) => {
  const seen = liveModules(page);
  await mockMusicEngine(page);
  await page.addInitScript(() => localStorage.setItem('community:active-host:v1', 'room-1'));
  await page.goto('/player/#/songs');
  await expect.poll(() => seen.some((path) => path.includes('CommunityBridge'))).toBe(true);
});
