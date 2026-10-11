import { expect, test } from '@playwright/test';
import { mockMusicEngine } from './music-browser-fixture';

for (const keys of [['yt:dQw4w9WgXcQ'], ['deezer:42']]) {
  test(`send a saved song without downloading or playing it locally (${keys[0]})`, async ({ page }) => {
    await mockMusicEngine(page);
    await page.route(url => url.pathname === '/api/library', route => route.fulfill({ json: { tracks: [], playlists: {}, settings: {}, podcast_subscriptions: [] } }));
    await page.route(url => url.pathname === '/api/library/saved', route => route.fulfill({ json: { saved: [{ keys, title: 'Canción remota', artist: 'Artista remoto' }] } }));
    await page.route('**/api/devices', route => route.fulfill({ json: { devices: [{ device_id: 'other-device', device_name: 'Portátil', socket_active: true }] } }));
    const commands: Array<Record<string, any>> = [];
    await page.route('**/api/playback/remote-command', async route => {
      commands.push(route.request().postDataJSON());
      await route.fulfill({ json: { status: 'sent' } });
    });
    const acquired: string[] = [];
    page.on('request', request => {
      if (/\/api\/preview\/stream/.test(request.url()) || /\/api\/downloader\/queue/.test(request.url()) && request.method() === 'POST') acquired.push(request.url());
    });
    await page.goto('/player/#/library?view=songs');
    const row = page.locator('[data-music-list-row], [data-song-row]').filter({ hasText: 'Canción remota' });
    await row.getByRole('button', { name: /^Más opciones/ }).click();
    await page.getByText('Reproducir en dispositivo', { exact: true }).click();
    await page.getByRole('button', { name: /^Portátil/ }).click();
    await expect.poll(() => commands.length).toBe(1);
    expect(commands[0]).toMatchObject({ device_id: 'other-device', command: 'play', track: { title: 'Canción remota', artist: 'Artista remoto', source: 'preview', originKeys: keys } });
    if (keys[0].startsWith('yt:')) expect(commands[0].track.id).toBe('dQw4w9WgXcQ');
    else expect(commands[0].track.pendingResolve).toMatchObject({ catalogItemId: keys[0], artist: 'Artista remoto', title: 'Canción remota' });
    expect(acquired).toEqual([]);
  });
}
