/** Real library + catalog + core stores; only the API boundary is simulated. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createComputed, createRoot } from 'solid-js';
import { writeFileSync } from 'node:fs';

const api = vi.hoisted(() => ({
  getLibrary: vi.fn(), getSaved: vi.fn(), getLibraryArtists: vi.fn(),
  getLibraryGenres: vi.fn(), getLibraryYears: vi.fn(),
}));
vi.mock('../lib/api', () => ({ api }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  api.getSaved.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

async function controlledCatalog() {
  const library = await import('./library');
  const catalog = await import('./catalog');
  const { state } = await import('./core');
  const server: { revision: string | undefined; account: string } = { revision: 'a', account: 'one' };
  const calls: Array<{ kind: string; revision?: string; account: string; start: number; end?: number }> = [];
  const publications: Array<{ time: number; name: string | undefined }> = [];
  let bytes = 0;
  let active = 0;
  let maxActive = 0;
  let failure = false;
  let holdYears = false;
  api.getLibrary.mockImplementation(async (known?: string) => known && known === server.revision ? null : ({
    revision: server.revision, tracks: [{ id: `${server.account}-track`, title: 'Track', artist: 'Artist' }],
  }));
  for (const [kind, mock] of [
    ['artists', api.getLibraryArtists], ['genres', api.getLibraryGenres], ['years', api.getLibraryYears],
  ] as const) {
    mock.mockImplementation(() => {
      const call = { kind, revision: server.revision, account: server.account, start: Date.now() };
      calls.push(call);
      const fail = failure && kind === 'artists';
      const delay = fail ? 10 : holdYears && kind === 'years' ? 200 : 100;
      active += 1;
      maxActive = Math.max(active, maxActive);
      const name = `${server.account}:${server.revision ?? 'legacy'}`;
      const body = kind === 'artists' ? [{ id: name, name, track_count: 1, album_count: 1 }]
        : kind === 'genres' ? [{ name, track_count: 1 }] : [{ year: 2026, track_count: 1 }];
      return new Promise((resolve, reject) => setTimeout(() => {
        Object.assign(call, { end: Date.now() });
        active -= 1;
        if (fail) reject(new Error('controlled failure'));
        else {
          bytes += new TextEncoder().encode(JSON.stringify({ [kind]: body })).length;
          resolve(body);
        }
      }, delay));
    });
  }
  const dispose = createRoot(dispose => {
    createComputed(() => {
      if (state.catalog.revision > 0) publications.push({ time: Date.now(), name: state.catalog.artists[0]?.name });
    });
    return dispose;
  });
  return {
    ...library, ...catalog, state, server, calls, publications, dispose,
    fail(value: boolean) { failure = value; },
    holdYears(value: boolean) { holdYears = value; },
    metrics() { return { requests: calls.length, responseBytes: bytes, maxActive, calls, publications }; },
  };
}

it('measures controlled catalog synchronization scenarios', async () => {
  const results: unknown[] = [];
  for (const scenario of ['same_revision', 'latest_revision', 'account_switch', 'failure', 'legacy', 'waiters']) {
    vi.resetModules();
    vi.setSystemTime(0);
    const h = await controlledCatalog();
    const settlements: Array<{ caller: number; time: number; success: boolean }> = [];
    if (scenario === 'legacy') h.server.revision = undefined;
    if (scenario === 'failure') { h.fail(true); h.holdYears(true); }
    if (scenario === 'waiters') {
      // Cast allows the identical trace to run on the historical no-argument API.
      const sync = h.syncCatalog as (revision?: string) => Promise<boolean>;
      void sync('a').then(success => settlements.push({ caller: 1, time: Date.now(), success }));
      await vi.advanceTimersByTimeAsync(10);
      void sync('a').then(success => settlements.push({ caller: 2, time: Date.now(), success }));
    } else {
      await h.syncLibrary();
      await vi.advanceTimersByTimeAsync(10);
      if (scenario === 'latest_revision') h.server.revision = 'b';
      if (scenario === 'account_switch') {
        h.server.account = 'two';
        h.invalidateLibrarySync();
      }
      if (scenario !== 'failure') await h.syncLibrary();
      await vi.advanceTimersByTimeAsync(10);
      if (scenario === 'latest_revision') h.server.revision = 'c';
      if (scenario !== 'failure') await h.syncLibrary();
    }
    await vi.advanceTimersByTimeAsync(250 - Date.now());
    if (scenario !== 'waiters') {
      h.fail(false);
      h.holdYears(false);
      await h.syncLibrary();
    }
    await vi.advanceTimersByTimeAsync(500 - Date.now());
    expect(h.state.catalog.loading).toBe(false);
    expect(h.state.catalog.ready).toBe(true);
    results.push({ scenario, ...h.metrics(), settlements, finalArtist: h.state.catalog.artists[0]?.name });
    h.dispose();
    expect(vi.getTimerCount()).toBe(0);
  }
  if (process.env.SOUNDSIBLE_CATALOG_MEASUREMENTS) {
    writeFileSync(process.env.SOUNDSIBLE_CATALOG_MEASUREMENTS, results.map(row => JSON.stringify(row)).join('\n') + '\n');
  }
});

it('shares the same promise and three requests for concurrent equal revisions', async () => {
  const h = await controlledCatalog();
  const first = h.syncCatalog('a');
  const settled = vi.fn();
  void first.then(settled);
  await vi.advanceTimersByTimeAsync(10);
  expect(h.syncCatalog('a')).toBe(first);
  await vi.advanceTimersByTimeAsync(89);
  expect(settled).not.toHaveBeenCalled();
  expect(h.state.catalog.loading).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(await first).toBe(true);
  expect(h.calls).toHaveLength(3);
  expect(h.publications).toEqual([{ time: 100, name: 'one:a' }]);
  h.dispose();
});

it('coalesces A -> B -> C, discards A and resolves every waiter only after C', async () => {
  const h = await controlledCatalog();
  const first = h.syncCatalog('a');
  await vi.advanceTimersByTimeAsync(10);
  h.server.revision = 'b';
  expect(h.syncCatalog('b')).toBe(first);
  h.server.revision = 'c';
  expect(h.syncCatalog('c')).toBe(first);
  const settled = vi.fn();
  void first.then(settled);
  await vi.advanceTimersByTimeAsync(90);
  expect(h.calls.filter(call => call.kind === 'artists').map(call => call.revision)).toEqual(['a', 'c']);
  expect(h.publications).toEqual([]);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(await first).toBe(true);
  expect(h.publications).toEqual([{ time: 200, name: 'one:c' }]);
  h.dispose();
});

it('acknowledges a catalog success after unchanged library refreshes', async () => {
  const h = await controlledCatalog();
  await h.syncLibrary();
  await vi.advanceTimersByTimeAsync(10);
  await h.syncLibrary();
  await h.syncLibrary();
  expect(h.state.libraryReady).toBe(true); // Library does not await catalog.
  expect(h.state.catalog.ready).toBe(false);
  await vi.advanceTimersByTimeAsync(90);
  await h.syncLibrary();
  expect(h.calls).toHaveLength(3);
  expect(h.publications).toHaveLength(1);
  h.dispose();
});

it('supersedes B when the manifest returns to an already acknowledged A', async () => {
  const h = await controlledCatalog();
  await h.syncLibrary();
  await vi.advanceTimersByTimeAsync(100);
  h.server.revision = 'b';
  await h.syncLibrary();
  await vi.advanceTimersByTimeAsync(10);
  h.server.revision = 'a';
  await h.syncLibrary();
  await vi.advanceTimersByTimeAsync(190);
  expect(h.publications.map(row => row.name)).toEqual(['one:a', 'one:a']);
  expect(h.state.catalog.artists[0].name).toBe('one:a');
  expect(h.calls).toHaveLength(9);
  await h.syncLibrary();
  expect(h.calls).toHaveLength(9);
  h.dispose();
});

it('starts a new account immediately and ignores old cleanup while the new round loads', async () => {
  const h = await controlledCatalog();
  await h.syncLibrary();
  await vi.advanceTimersByTimeAsync(10);
  h.invalidateLibrarySync();
  h.server.account = 'two'; // Deliberately reuse opaque revision "a".
  await h.syncLibrary();
  expect(h.calls.filter(call => call.account === 'two').map(call => call.start)).toEqual([10, 10, 10]);
  await vi.advanceTimersByTimeAsync(90);
  expect(h.state.catalog.loading).toBe(true);
  expect(h.state.catalog.ready).toBe(false);
  expect(h.publications).toEqual([]);
  await vi.advanceTimersByTimeAsync(10);
  expect(h.publications).toEqual([{ time: 110, name: 'two:a' }]);
  await h.syncLibrary();
  expect(h.calls).toHaveLength(6);
  h.dispose();
});

it('does not apply an abandoned round that finishes after the new account', async () => {
  const h = await controlledCatalog();
  h.holdYears(true);
  await h.syncLibrary();
  await vi.advanceTimersByTimeAsync(10);
  h.invalidateLibrarySync();
  h.holdYears(false);
  h.server.account = 'two';
  await h.syncLibrary();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.state.catalog.artists[0].name).toBe('two:a');
  await vi.advanceTimersByTimeAsync(100);
  expect(h.publications).toEqual([{ time: 110, name: 'two:a' }]);
  expect(h.state.catalog.loading).toBe(false);
  await h.syncLibrary();
  expect(h.calls).toHaveLength(6);
  h.dispose();
});

it('invalidates before the first microtask without sending a request or leaving loading set', async () => {
  const h = await controlledCatalog();
  const old = h.syncCatalog('a');
  h.invalidateCatalogSync();
  expect(await old).toBe(false);
  expect(h.calls).toHaveLength(0);
  expect(h.state.catalog.loading).toBe(false);
  expect(h.state.catalog.ready).toBe(false);
  h.dispose();
});

it('waits for failed-round siblings before requesting a newer revision', async () => {
  const h = await controlledCatalog();
  h.fail(true);
  h.holdYears(true);
  const flight = h.syncCatalog('a');
  await vi.advanceTimersByTimeAsync(20);
  h.fail(false);
  h.holdYears(false);
  h.server.revision = 'b';
  expect(h.syncCatalog('b')).toBe(flight);
  await vi.advanceTimersByTimeAsync(179);
  expect(h.calls).toHaveLength(3);
  expect(h.publications).toEqual([]);
  expect(h.state.catalog.loading).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.calls).toHaveLength(6);
  expect(h.calls.slice(3).every(call => call.start === 200)).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  expect(await flight).toBe(true);
  expect(h.metrics().maxActive).toBe(3);
  expect(h.publications).toEqual([{ time: 300, name: 'one:b' }]);
  h.dispose();
});

it('preserves the previous catalog on partial failure and retries on a later unchanged manifest', async () => {
  const h = await controlledCatalog();
  await h.syncLibrary();
  await vi.advanceTimersByTimeAsync(100);
  h.fail(true);
  h.holdYears(true);
  h.server.revision = 'b';
  await h.syncLibrary();
  await vi.advanceTimersByTimeAsync(200);
  expect(h.state.catalog.artists[0].name).toBe('one:a');
  expect(h.state.catalog.loading).toBe(false);
  expect(h.state.catalog.ready).toBe(true);
  expect(vi.getTimerCount()).toBe(0); // No automatic retry loop.
  h.fail(false);
  h.holdYears(false);
  await h.syncLibrary();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.state.catalog.artists[0].name).toBe('one:b');
  expect(h.publications.map(row => row.name)).toEqual(['one:a', 'one:b']);
  expect(h.calls).toHaveLength(9);
  h.dispose();
});

it('groups legacy invalidations but still refreshes again after completion', async () => {
  const h = await controlledCatalog();
  h.server.revision = undefined;
  await h.syncLibrary();
  await vi.advanceTimersByTimeAsync(10);
  await h.syncLibrary();
  await h.syncLibrary();
  await vi.advanceTimersByTimeAsync(190);
  expect(h.calls).toHaveLength(6);
  expect(h.publications).toEqual([{ time: 200, name: 'one:legacy' }]);
  await h.syncLibrary();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.calls).toHaveLength(9);
  h.dispose();
});

it('handles synchronous API exceptions without leaving an unresolved flight', async () => {
  const h = await controlledCatalog();
  api.getLibraryArtists.mockImplementationOnce(() => { throw new Error('sync failure'); });
  const failed = h.syncCatalog('a');
  await vi.advanceTimersByTimeAsync(100);
  expect(await failed).toBe(false);
  expect(h.publications).toEqual([]);
  const recovered = h.syncCatalog('a');
  await vi.advanceTimersByTimeAsync(100);
  expect(await recovered).toBe(true);
  h.dispose();
});

it('shares the assigned promise with subscribers reacting to loading', async () => {
  const h = await controlledCatalog();
  let joined: Promise<boolean> | undefined;
  const stop = createRoot(dispose => {
    createComputed(() => { if (h.state.catalog.loading) joined = h.syncCatalog('a'); });
    return dispose;
  });
  const flight = h.syncCatalog('a');
  await vi.advanceTimersByTimeAsync(100);
  expect(joined).toBe(flight);
  expect(await flight).toBe(true);
  expect(h.calls).toHaveLength(3);
  stop();
  h.dispose();
});

it('continues when publication itself requests the next revision', async () => {
  const h = await controlledCatalog();
  let joined: Promise<boolean> | undefined;
  const stop = createRoot(dispose => {
    createComputed(() => {
      if (h.state.catalog.revision === 1) {
        h.server.revision = 'b';
        joined = h.syncCatalog('b');
      }
    });
    return dispose;
  });
  const flight = h.syncCatalog('a');
  await vi.advanceTimersByTimeAsync(100);
  expect(joined).toBe(flight);
  await vi.advanceTimersByTimeAsync(100);
  expect(await flight).toBe(true);
  expect(h.publications.map(row => row.name)).toEqual(['one:a', 'one:b']);
  expect(h.calls).toHaveLength(6);
  stop();
  h.dispose();
});

it('preserves an available catalog when a playlist mutation only invalidates the manifest', async () => {
  const h = await controlledCatalog();
  await h.syncLibrary();
  await vi.advanceTimersByTimeAsync(100);
  h.invalidateLibrarySync();
  expect(h.state.catalog.ready).toBe(true);
  expect(h.state.catalog.loading).toBe(false);
  expect(h.state.catalog.artists[0].name).toBe('one:a');
  expect(vi.getTimerCount()).toBe(0);
  h.dispose();
});
