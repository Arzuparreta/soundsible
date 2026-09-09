import { expect, test } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';

test('automatically uploads evidence, retries persisted batches after reload, and partitions accounts', async ({ page }) => {
  await mockMusicEngine(page);
  let fail = true;
  const attempts: Array<{ id: string; userId: string; capture: Record<string, string>; events: Array<{ event: string; sequence: number }> }> = [];
  await page.route('**/api/playback/trace', async (route) => {
    const batch = route.request().postDataJSON();
    attempts.push(batch);
    if (fail) await route.abort();
    else await route.fulfill({ json: { id: batch.id, enabled: true } });
  });
  await page.goto('/player/#/');
  await expect.poll(() => attempts.length).toBeGreaterThan(0);
  const original = attempts[0];
  expect(original.events[0].event).toBe('capture.start');
  expect(original.capture.clientRevision).toBe('development-unverified');
  // The application itself persists the failed upload. No settings or export.
  await expect.poll(() => page.evaluate(async () => {
    const request = indexedDB.open('soundsible-playback-traces', 1);
    const db = await new Promise<IDBDatabase>((resolve) => { request.onsuccess = () => resolve(request.result); });
    const rows = db.transaction('batches').objectStore('batches').getAll();
    return await new Promise<number>((resolve) => { rows.onsuccess = () => { resolve(rows.result.length); db.close(); }; });
  })).toBeGreaterThan(0);
  fail = false;
  await page.reload();
  await expect.poll(() => attempts.filter((b) => b.id === original.id).length).toBeGreaterThan(1);
  await expect.poll(() => page.evaluate(async (id) => {
    const request = indexedDB.open('soundsible-playback-traces', 1);
    const db = await new Promise<IDBDatabase>((resolve) => { request.onsuccess = () => resolve(request.result); });
    const row = db.transaction('batches').objectStore('batches').get(id);
    return await new Promise<boolean>((resolve) => { row.onsuccess = () => { resolve(row.result === undefined); db.close(); }; });
  }, original.id)).toBe(true);
  expect(JSON.stringify(attempts)).not.toMatch(/library-track-|Canción|credential|\.mp3/);

  // Leave old-account evidence pending; another login must not transmit it.
  fail = true;
  await page.reload();
  await expect.poll(() => attempts.some((b) => b.capture.id !== original.capture.id)).toBe(true);
  await page.route('**/api/auth/state', (route) => route.fulfill({ json: {
    requires_login: true, user: { id: 'second-account', username: 'other', role: 'member', has_password: true },
  } }));
  await page.goto('about:blank');
  const boundary = attempts.length;
  fail = false;
  await page.goto('/player/#/');
  await expect.poll(() => attempts.slice(boundary).some((b) => b.userId === 'second-account')).toBe(true);
  expect(attempts.slice(boundary).every((b) => b.userId === 'second-account')).toBe(true);
});

test('server telemetry opt-out stops automatic collection and uploads', async ({ page }) => {
  await mockMusicEngine(page);
  let requests = 0;
  await page.route('**/api/playback/trace', (route) => {
    requests++;
    return route.fulfill({ json: { id: route.request().postDataJSON().id, enabled: false } });
  });
  await page.goto('/player/#/');
  await expect.poll(() => requests).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(5500);
  expect(requests).toBe(1);
});
