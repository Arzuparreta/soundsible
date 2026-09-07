import { expect, test, type Page } from '@playwright/test';

/**
 * The bug this covers: on iOS, holding a song opens the action sheet, and
 * Safari — which reads the same gesture as "select the text under the finger"
 * — lands its selection on the sheet's own title, because that is what has
 * appeared under the finger by the time the platform gesture resolves.
 *
 * A synthetic pointer cannot drive WebKit's native selection recogniser, so
 * what is asserted here is the mechanism: the guard is armed for exactly the
 * length of the press, it makes the sheet unselectable while it is, and it
 * gives selection back afterwards. The gesture itself is verified by hand on a
 * device.
 */

const TRACK = {
  id: 'local:1',
  title: 'Luz de verano',
  artist: 'Mar Abierta',
  album: 'Primer disco',
  duration: 198,
  cover: '',
  path: '/music/luz-de-verano.mp3',
  favourite: false,
  downloaded: true,
  added_at: '2026-01-01T00:00:00Z',
};

async function mockEngine(page: Page) {
  await page.routeWebSocket('**/socket.io/**', (socket) => socket.close());
  await page.route('**/socket.io/**', (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path === '/api/auth/state') {
      body = {
        requires_login: true,
        user: {
          id: 'press-user',
          username: 'press',
          display_name: 'Press QA',
          role: 'admin',
          has_password: true,
        },
      };
    } else if (path === '/api/library') {
      body = { tracks: [TRACK], playlists: {}, settings: {}, podcast_subscriptions: [] };
    } else if (path === '/api/library/favourites') {
      body = [];
    } else if (path === '/api/downloader/queue') {
      body = { queue: [], is_processing: false, logs: [] };
    } else if (path === '/api/discovery/settings') {
      body = { learning_enabled: true, autoplay_enabled: false };
    } else if (path === '/api/downloader/config') {
      body = { quality: 'high', auto_update_ytdlp: false };
    } else if (path === '/api/devices' || path === '/api/paired-devices') {
      body = { devices: [] };
    } else if (path === '/api/pairing/sessions') {
      body = { sessions: [] };
    } else if (path === '/api/discovery/music/feed') {
      body = { sections: [], items: [] };
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

const TOUCH = { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 120, clientY: 240 };

/** What the document reports for an element, whichever spelling the engine uses. */
const selectability = (element: Element) => {
  const style = getComputedStyle(element);
  return style.userSelect || (style as unknown as { webkitUserSelect: string }).webkitUserSelect;
};

const holdGuard = (page: Page) => page.locator('html').getAttribute('data-hold-gesture');

async function openLibrary(page: Page) {
  await mockEngine(page);
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('lang', 'en');
  });
  await page.goto('/player/#/');
  const row = page.getByRole('button', { name: 'Play Luz de verano by Mar Abierta' });
  await expect(row).toBeVisible();
  return row;
}

test('a long press on a song owns the selection gesture, and only for its own length', async ({ page }) => {
  const row = await openLibrary(page);

  await row.dispatchEvent('pointerdown', TOUCH);

  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-hold-gesture', '');

  // The sheet's title is the song title — the very text Safari would otherwise
  // select, because the sheet opened under the still-held finger.
  const title = sheet.getByText('Luz de verano', { exact: true });
  expect(await title.evaluate(selectability)).toBe('none');

  await row.dispatchEvent('pointerup', TOUCH);

  // The guard outlives the lift by a beat, then hands selection back.
  await expect.poll(() => holdGuard(page)).toBeNull();
  expect(await title.evaluate(selectability)).not.toBe('none');
});

test('a press that turns into a scroll gives the gesture straight back', async ({ page }) => {
  const row = await openLibrary(page);

  await row.dispatchEvent('pointerdown', TOUCH);
  await expect(page.locator('html')).toHaveAttribute('data-hold-gesture', '');

  await row.dispatchEvent('pointermove', { ...TOUCH, clientY: TOUCH.clientY + 120 });

  await expect.poll(() => holdGuard(page)).toBeNull();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('dragging across a song title selects it instead of playing the song', async ({ page, isMobile }) => {
  test.skip(!!isMobile, 'coarse pointers keep pressable chrome unselectable by design');
  const row = await openLibrary(page);
  const title = row.getByText('Luz de verano', { exact: true });
  const box = (await title.boundingBox())!;

  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  expect(await page.evaluate(() => window.getSelection()?.toString().trim())).toContain('Luz');
  // The click that ends the drag is not an activation.
  await expect(page.locator('[data-now-playing]')).toHaveCount(0);
});

test('a plain click on a song still plays it', async ({ page }) => {
  const row = await openLibrary(page);

  await row.click();

  await expect(page.locator('[data-now-playing]').first()).toBeVisible();
});
