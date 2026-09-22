import { expect, test } from '@playwright/test';

for (const scenario of ['unchanged', 'changed', 'account', 'failure'] as const) {
  test(`catalog synchronization: ${scenario}`, async ({ page }) => {
    let revision = 'a';
    let account = 'one';
    let failing = scenario === 'failure';
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    let completed = 0;
    await page.route('**/player/catalog-sync-test', route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>Catalog synchronization</title>',
    }));
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/library') {
        await route.fulfill({ headers: { ETag: `W/"${revision}"` },
          json: { tracks: [{ id: account, title: account, artist: 'Artist' }] } });
      } else if (['/api/library/artists', '/api/library/genres', '/api/library/years'].includes(path)) {
        const name = `${account}:${revision}`;
        calls.push(name);
        const first = calls.length <= 3;
        const fail = failing && path.endsWith('/artists');
        if (first) await held;
        const key = path.split('/').at(-1)!;
        await route.fulfill({ status: fail ? 503 : 200, json: fail ? { error: 'controlled failure' } : {
          [key]: key === 'artists' ? [{ id: name, name, track_count: 1, album_count: 1 }] : [],
        } });
        completed += 1;
      } else await route.fulfill({ json: [] });
    });
    await page.goto('/player/catalog-sync-test');
    const sync = () => page.evaluate(async () => {
      const path = '/player/src/stores/library.ts';
      const { syncLibrary } = await import(/* @vite-ignore */ path);
      await syncLibrary();
    });
    const observed = () => page.evaluate(async () => {
      const path = '/player/src/stores/core.ts';
      const { state } = await import(/* @vite-ignore */ path);
      return { loading: state.catalog.loading, ready: state.catalog.ready,
        name: state.catalog.artists[0]?.name, revision: state.catalog.revision };
    });
    await sync();
    await expect.poll(() => calls.length).toBe(3);
    if (scenario === 'account') {
      account = 'two';
      await page.evaluate(async () => {
        const path = '/player/src/stores/library.ts';
        const { invalidateLibrarySync } = await import(/* @vite-ignore */ path);
        invalidateLibrarySync();
      });
      await sync();
      await expect.poll(observed).toEqual({ loading: false, ready: true, name: 'two:a', revision: 1 });
    } else if (scenario === 'changed') {
      revision = 'b';
      await sync();
      revision = 'c';
      await sync();
      expect(calls).toHaveLength(3);
    } else if (scenario === 'unchanged') {
      await sync();
      await sync();
      expect(calls).toHaveLength(3);
    }
    release();
    if (scenario === 'failure') {
      await expect.poll(observed).toEqual({ loading: false, ready: true, name: undefined, revision: 0 });
      failing = false;
      await sync();
    }
    await expect.poll(observed).toEqual({ loading: false, ready: true,
      name: `${account}:${revision}`, revision: 1 });
    const expected = scenario === 'unchanged' ? 3 : 6;
    await expect.poll(() => completed).toBe(expected);
    await sync();
    expect(calls).toHaveLength(expected);
    expect(calls.filter(name => name === 'one:b')).toHaveLength(0);
    await test.info().attach('catalog-observation.json', {
      body: JSON.stringify({ scenario, calls, state: await observed() }), contentType: 'application/json',
    });
  });
}
