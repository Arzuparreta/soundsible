import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockMusicEngine, openMiniPlayer } from './music-browser-fixture';
import { settledBox } from './settle';

/**
 * Cards and rows whose whole surface is one link or button, laid over the
 * contents as a transparent overlay so the artist credit inside can stay a
 * link of its own. An overlay without a layer of its own only receives the taps
 * that land on unpositioned contents: anything laid out after it that is
 * positioned, transformed or translucent paints over it and swallows the tap.
 * That is how album covers stopped opening their album (#233) and how the
 * playing song's equaliser stopped answering clicks.
 */

/** Points across `target` where a press reaches neither it nor another control
 * of the same card. Whatever lies over the card from elsewhere on the page —
 * the floating player, a sticky header — is that element's business. */
async function deadPoints(target: Locator): Promise<string[]> {
  return target.evaluate((overlay) => {
    const host = overlay.parentElement!;
    const box = overlay.getBoundingClientRect();
    const dead: string[] = [];
    for (let i = 1; i < 12; i++) {
      for (let j = 1; j < 8; j++) {
        const x = box.left + (box.width * i) / 12;
        const y = box.top + (box.height * j) / 8;
        const hit = document.elementFromPoint(x, y);
        if (!hit || !host.contains(hit) || overlay.contains(hit)) continue;
        const control = hit.closest('a, button, [role="button"]');
        if (control && host.contains(control)) continue;
        dead.push(`${Math.round(x - box.left)},${Math.round(y - box.top)} → ${hit.tagName.toLowerCase()}.${hit.className}`);
      }
    }
    return dead;
  });
}

test('search result cards take a press anywhere on them', async ({ page }) => {
  await mockMusicEngine(page);
  const cover = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>')}`;
  await page.route('**/api/catalog/search?**', (route) => route.fulfill({ json: {
    items: [
      { id: 'album:1', type: 'album', source: 'deezer', title: 'Disco buscado', artist: 'Artista 7', cover,
        external_ids: { deezer_album_id: '20' } },
      { id: 'artist:1', type: 'artist', source: 'deezer', title: 'Artista buscado', cover,
        external_ids: { deezer_artist_id: '1' } },
    ],
    sections: [{ id: 'top', item_ids: ['album:1'] }, { id: 'albums', item_ids: ['album:1'] }, { id: 'artists', item_ids: ['artist:1'] }],
  } }));
  await page.goto('/player/#/search?q=disco');
  const cards = page.getByRole('link', { name: 'Disco buscado', exact: true });
  await expect(cards).toHaveCount(2);
  for (const card of [...await cards.all(), page.getByRole('link', { name: 'Artista buscado', exact: true })]) {
    await expect(card).toBeVisible();
    expect(await deadPoints(card)).toEqual([]);
  }
});

test('the playing song in the queue answers a click on its equaliser', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the phone lists the queue with its own rows');
  await mockMusicEngine(page);
  await page.goto('/player/#/');
  await page.getByRole('button', { name: /Reproducir Canción de biblioteca 320/ }).click();
  await openMiniPlayer(page, /Canción de biblioteca 320/);
  const queue = page.locator('[data-now-playing-tile="queue"]');
  const current = queue.getByRole('button', { name: 'Canción de biblioteca 320 — Artista 7', exact: true });
  await expect(current).toBeVisible();
  await settledBox(page, current);
  expect(await deadPoints(current)).toEqual([]);
  const bars = await queue.locator('[data-now-playing] i, [data-current] i').evaluateAll((items) =>
    items.map((bar) => {
      const box = bar.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.bottom - 1);
      return hit?.closest('button')?.getAttribute('aria-label') ?? `${hit?.tagName.toLowerCase()}.${hit?.className}`;
    }));
  expect(bars.length).toBeGreaterThan(0);
  expect(new Set(bars)).toEqual(new Set(['Canción de biblioteca 320 — Artista 7']));
});
