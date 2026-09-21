import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

test.beforeEach(async ({ page }) => {
  await page.route('**/player/revisions-test', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Library revisions</title>',
  }));
  await page.goto('/player/revisions-test');
});

test('real fetch handles 304 without replacing library or catalog and reload starts without a validator', async ({ page, baseURL }) => {
  let revision = 'a';
  const requests: Array<string | undefined> = [];
  let catalogRequests = 0;
  // A real HTTP server is needed: WebKit's interception API refuses 304
  // fulfillment. Proxy source modules to Vite; send API responses over TCP.
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname;
    if (path === '/api/library') {
      const validator = req.headers['if-none-match'];
      requests.push(validator);
      const etag = `W/"${revision}"`;
      res.writeHead(validator === etag ? 304 : 200, {
        ETag: etag, 'Cache-Control': 'private, no-cache', Vary: 'Cookie', 'Content-Type': 'application/json',
      });
      res.end(validator === etag ? '' : JSON.stringify({ tracks: Array.from({ length: 1000 }, (_, i) => ({
        id: `${revision}-${i}`, title: `Song ${i}`, artist: 'Artist', artwork_revision: revision,
      })) }));
    } else if (path.startsWith('/api/')) {
      if (['/api/library/artists', '/api/library/genres', '/api/library/years'].includes(path)) catalogRequests++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    } else {
      try {
        const upstream = await fetch(`${baseURL}${req.url}`);
        res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'text/javascript' });
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch {
        res.writeHead(502);
        res.end();
      }
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/player/revisions-test`);
    await page.evaluate(async () => {
      const { syncLibrary } = await import('/player/src/stores/library.ts');
      await syncLibrary();
    });
    await expect.poll(() => page.evaluate(async () => {
      const { state } = await import('/player/src/stores/core.ts');
      return state.catalog.ready;
    })).toBe(true);
    const unchanged = await page.evaluate(async () => {
      const { syncLibrary } = await import('/player/src/stores/library.ts');
      const { state } = await import('/player/src/stores/core.ts');
      const before = state.library;
      const first = before[0];
      const catalog = state.catalog.revision;
      await syncLibrary();
      return { sameArray: before === state.library, sameTrack: first === state.library[0],
        sameCatalog: catalog === state.catalog.revision, count: state.library.length, error: state.libraryError };
    });
    expect(unchanged).toEqual({ sameArray: true, sameTrack: true, sameCatalog: true, count: 1000, error: false });
    expect(requests).toEqual([undefined, 'W/"a"']);
    expect(catalogRequests).toBe(3);
    revision = 'b';
    expect(await page.evaluate(async () => {
      const { syncLibrary } = await import('/player/src/stores/library.ts');
      const { state } = await import('/player/src/stores/core.ts');
      await syncLibrary();
      return state.library[0].id;
    })).toBe('b-0');
    await expect.poll(() => catalogRequests).toBe(6);
    await page.reload();
    await page.evaluate(async () => {
      const { syncLibrary } = await import('/player/src/stores/library.ts');
      await syncLibrary();
    });
    expect(requests).toEqual([undefined, 'W/"a"', 'W/"a"', undefined]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('an abandoned account response cannot overwrite tracks or artwork after a new account loads', async ({ page }) => {
  let releaseOld!: () => void;
  const held = new Promise<void>(resolve => { releaseOld = resolve; });
  let first = true;
  let oldStarted = false;
  await page.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname !== '/api/library') {
      await route.fulfill({ contentType: 'application/json', body: '{}' });
      return;
    }
    const old = first;
    first = false;
    if (old) { oldStarted = true; await held; }
    const account = old ? 'old' : 'new';
    await route.fulfill({ contentType: 'application/json', headers: { ETag: `W/"${account}"` },
      body: JSON.stringify({ tracks: [{ id: 'song', title: account, artist: 'Artist', artwork_revision: account }] }),
    });
  });
  const oldRun = page.evaluate(async () => {
    const { syncLibrary } = await import('/player/src/stores/library.ts');
    await syncLibrary();
  });
  await expect.poll(() => oldStarted).toBe(true);
  await page.evaluate(async () => {
    const { syncLibrary, invalidateLibrarySync } = await import('/player/src/stores/library.ts');
    invalidateLibrarySync();
    await syncLibrary();
  });
  releaseOld();
  await oldRun;
  const result = await page.evaluate(async () => {
    const { state } = await import('/player/src/stores/core.ts');
    const { artworkCandidates } = await import('/player/src/lib/media.ts');
    return { title: state.library[0].title, artwork: artworkCandidates(`${location.origin}/api/static/cover/song`) };
  });
  expect(result.title).toBe('new');
  expect(result.artwork).toContain('rev=new');
  expect(result.artwork).not.toContain('rev=old');
});
