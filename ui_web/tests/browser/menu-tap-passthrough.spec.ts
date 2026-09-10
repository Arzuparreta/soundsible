import { expect, test, type Page } from '@playwright/test';

/**
 * The bug this covers: choosing an action in a song's ⋯ menu also activated
 * whatever the menu was covering. Tapping "Add to queue" queued the song and
 * played the unrelated song that happened to sit under that button.
 *
 * The cause is the mouse event a touch leaves behind. Rows and menu items
 * activate on `pointerup` (lib/responsiveTap), so by the time the browser
 * synthesises the click for that same tap, the sheet has closed and the click
 * is hit-tested onto the list underneath. One finger, two activations.
 */

const TRACKS = Array.from({ length: 12 }, (_, i) => ({
  id: `local:${i + 1}`,
  title: `Song ${String(i + 1).padStart(2, '0')}`,
  artist: `Artist ${String(i + 1).padStart(2, '0')}`,
  album: 'Primer disco',
  duration: 180 + i,
  cover: '',
  path: `/music/song-${i + 1}.mp3`,
  favourite: false,
  downloaded: true,
  added_at: '2026-01-01T00:00:00Z',
}));

async function mockEngine(page: Page) {
  await page.routeWebSocket('**/socket.io/**', (socket) => socket.close());
  await page.route('**/socket.io/**', (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path === '/api/auth/state') {
      body = {
        requires_login: true,
        user: { id: 'tap-user', username: 'tap', display_name: 'Tap QA', role: 'admin', has_password: true },
      };
    } else if (path === '/api/library') {
      body = { tracks: TRACKS, playlists: {}, settings: {}, podcast_subscriptions: [] };
    } else if (path === '/api/library/favourites') {
      body = [];
    } else if (path === '/api/downloader/queue') {
      body = { queue: [], is_processing: false, logs: [] };
    } else if (path === '/api/discovery/settings') {
      body = { learning_enabled: true, autoplay_enabled: false };
    } else if (path === '/api/downloader/config') {
      body = { quality: 'high', auto_update_ytdlp: false };
    } else if (path === '/api/discovery/music/feed') {
      body = { sections: [], items: [] };
    } else if (path === '/api/devices' || path === '/api/paired-devices' || path === '/api/pairing/sessions') {
      body = { devices: [], sessions: [] };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('lang', 'en');
  });
}

const row = (page: Page, n: number) =>
  page.getByRole('button', { name: `Play Song ${String(n).padStart(2, '0')} by Artist ${String(n).padStart(2, '0')}` });

/** The topmost song row under a point, ignoring the overlay stacked above it.
 * Null when the menu covers no row — which would make the test prove nothing. */
async function rowUnder(page: Page, x: number, y: number): Promise<string | null> {
  return page.evaluate(([px, py]) => {
    // The desktop row is now a container with independent playback and artist
    // controls. Find the row first; the point need not land on its title button.
    const rowSelector = '[data-music-list-row], [data-song-row]';
    const covered = document.elementsFromPoint(px, py)
      .map((element) => element.closest<HTMLElement>(rowSelector))
      .find((element) => element && !element.closest('[role="dialog"], [role="menu"]'));
    return covered?.querySelector<HTMLElement>('button[aria-label^="Play "], [role="button"][aria-label^="Play "]')?.getAttribute('aria-label') ?? null;
  }, [x, y]);
}

async function openLibrary(page: Page) {
  await mockEngine(page);
  await page.goto('/player/#/');
  await expect(row(page, 1)).toBeVisible();
}

test('an action chosen in the song menu never reaches the list underneath', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the compatibility click only exists behind a touch');
  await openLibrary(page);

  // The topmost row, so its sheet is the furthest from it: what the sheet
  // covers is other songs.
  await page.locator('[data-music-list-row]').filter({ has: row(page, 12) })
    .getByRole('button', { name: /^More options/ }).tap();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();

  // A menu action with no playback of its own: whatever plays after this tap
  // was played by the list underneath, not by the action.
  const addFavourite = sheet.getByRole('button', { name: 'Add to favourites' });
  const box = (await addFavourite.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  const covered = await rowUnder(page, x, y);
  expect(covered, 'the sheet must cover a song row for this to test anything').not.toBeNull();

  await page.touchscreen.tap(x, y);

  // The item took the tap — closing is what choosing one does…
  await expect(sheet).toHaveCount(0);
  // …and nothing else did. Before the guard, the row under that button was
  // playing by now.
  await expect(page.locator('[data-now-playing]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: covered! })).not.toHaveAttribute('data-now-playing');
});

test('the same choice on a pointer leaves the row under the popover alone', async ({ page, isMobile }) => {
  test.skip(!!isMobile, 'the cursor-anchored popover is a fine-pointer surface');
  await openLibrary(page);

  const anchor = (await row(page, 12).boundingBox())!;
  await page.mouse.click(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2, { button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();

  const addFavourite = menu.getByRole('button', { name: 'Add to favourites' });
  const box = (await addFavourite.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  const covered = await rowUnder(page, x, y);
  expect(covered, 'the popover must cover a song row for this to test anything').not.toBeNull();

  // A mouse has no second act: the menu closes inside the click it was given,
  // and nothing else is dispatched. This is the case the touch one lost.
  await page.mouse.click(x, y);

  await expect(menu).toHaveCount(0);
  await expect(page.locator('[data-now-playing]')).toHaveCount(0);
});
