import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Real IndexedDB, with no application collector adding unrelated records.
  await page.route('**/player/outbox-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Outbox</title>' }));
  await page.goto('/player/outbox-test');
});

test('migrates 24 hours offline, reads six rows, and preserves account quotas and loss across reload', async ({ page }) => {
  test.setTimeout(90_000);
  const result = await page.evaluate(async () => {
    const name = 'soundsible-playback-traces';
    const old = indexedDB.open(name, 1);
    old.onupgradeneeded = () => old.result.createObjectStore('batches', { keyPath: 'id' });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      old.onsuccess = () => resolve(old.result); old.onerror = () => reject(old.error);
    });
    // One batch every ten seconds for a full day, plus another account.
    const tx = db.transaction('batches', 'readwrite');
    const store = tx.objectStore('batches');
    const now = Date.now();
    for (let i = 0; i < 8640; i++) store.put({
      id: String(i).padStart(6, '0'), userId: 'a', createdAt: now - 86400_000 + i * 10_000,
      capture: {}, dropped: 0, events: [{ event: 'offline', padding: 'x'.repeat(2000) }],
    });
    for (let i = 0; i < 20; i++) store.put({
      id: 'b-' + i, userId: 'b', createdAt: now, capture: {}, dropped: 0, events: [{}],
    });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    db.close();
    const { PlaybackTraceOutbox } = await import('/player/src/lib/playbackTraceOutbox.ts');
    const a = new PlaybackTraceOutbox('a');
    await a.maintain(); // includes the one-time cursor migration
    const getAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = () => { throw new Error('full scan forbidden'); };
    const descriptor = Object.getOwnPropertyDescriptor(IDBCursorWithValue.prototype, 'value')!;
    let materialized = 0;
    Object.defineProperty(IDBCursorWithValue.prototype, 'value', {
      ...descriptor, get() { materialized++; return descriptor.get!.call(this); },
    });
    const window = await a.pending();
    const readRows = materialized;
    Object.defineProperty(IDBCursorWithValue.prototype, 'value', descriptor);
    IDBObjectStore.prototype.getAll = getAll;
    const b = new PlaybackTraceOutbox('b');
    await a.remove('b-0');
    const bWindow = await b.pending();
    const open = indexedDB.open(name);
    const current = await new Promise<IDBDatabase>(resolve => { open.onsuccess = () => resolve(open.result); });
    const read = current.transaction('accounts').objectStore('accounts').get('a');
    const meta = await new Promise<{ bytes: number; count: number; lost: number }>(resolve => { read.onsuccess = () => resolve(read.result); });
    await a.put({ id: 'latest', userId: 'a', createdAt: now + 1, capture: {}, dropped: 0,
      events: [{ event: 'latest', padding: 'x'.repeat(40_000) }] });
    const latestRead = current.transaction('accounts').objectStore('accounts').get('a');
    const afterPut = await new Promise<{ bytes: number; count: number; lost: number }>(resolve => {
      latestRead.onsuccess = () => resolve(latestRead.result);
    });
    current.close();
    return { afterPut, readRows, ids: window.map((row: { id: string }) => row.id), meta,
      reported: window[0].dropped, bIds: bWindow.map((row: { id: string }) => row.id) };
  });
  expect(result.readRows).toBe(6);
  expect(result.ids).toHaveLength(6);
  expect(result.meta.count).toBeLessThanOrEqual(8192);
  expect(result.meta.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(result.meta.lost).toBe(8640 - result.meta.count);
  expect(result.reported).toBe(result.meta.lost);
  expect(result.bIds).toContain('b-0');
  expect(result.afterPut.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(result.afterPut.count).toBeLessThanOrEqual(8192);
  expect(result.afterPut.lost - result.meta.lost).toBeGreaterThan(0);
  expect(result.afterPut.lost - result.meta.lost).toBeLessThanOrEqual(64);

  await page.reload();
  const reloaded = await page.evaluate(async () => {
    const { PlaybackTraceOutbox } = await import('/player/src/lib/playbackTraceOutbox.ts');
    const a = new PlaybackTraceOutbox('a');
    const rows = await a.pending();
    await a.clear();
    const b = new PlaybackTraceOutbox('b');
    return { dropped: rows[0].dropped, left: (await a.pending()).length, other: (await b.pending()).length };
  });
  expect(reloaded).toEqual({ dropped: result.afterPut.lost, left: 0, other: 6 });
});

test('admission replaces atomically, measures UTF-8 bytes and prunes a bounded number of old rows', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { PlaybackTraceOutbox } = await import('/player/src/lib/playbackTraceOutbox.ts');
    const a = new PlaybackTraceOutbox('a');
    const row = { id: 'same', userId: 'a', createdAt: Date.now(), capture: {}, dropped: 0, events: ['🎵'.repeat(500)] };
    await Promise.all([a.put(row), new PlaybackTraceOutbox('a').put(row)]);
    const open = indexedDB.open('soundsible-playback-traces');
    const db = await new Promise<IDBDatabase>(resolve => { open.onsuccess = () => resolve(open.result); });
    const metadata = async () => {
      const get = db.transaction('accounts').objectStore('accounts').get('a');
      return new Promise<{ count: number; bytes: number; lost: number }>(resolve => { get.onsuccess = () => resolve(get.result); });
    };
    const initial = await metadata();
    const replacement = { ...row, events: ['short'] };
    await a.put(replacement);
    const replaced = await metadata();
    for (let i = 0; i < 150; i++) await a.put({ ...row, id: 'expire-' + i });
    const originalNow = Date.now;
    Date.now = () => originalNow() + 8 * 86400_000;
    await a.maintain();
    const maintained = await metadata();
    // Expired rows are excluded by the index range, without reading them.
    const pending = await a.pending();
    Date.now = originalNow;
    db.close();
    return { initial, replaced, maintained, pending: pending.length,
      expected: new TextEncoder().encode(JSON.stringify(row)).byteLength,
      expectedReplacement: new TextEncoder().encode(JSON.stringify(replacement)).byteLength };
  });
  expect(result.initial).toEqual({ userId: 'a', count: 1, bytes: result.expected, lost: 0 });
  expect(result.replaced).toEqual({ userId: 'a', count: 1, bytes: result.expectedReplacement, lost: 0 });
  expect(result.maintained.count).toBe(151 - 64);
  expect(result.maintained.lost).toBe(64);
  expect(result.pending).toBe(0);
});

test('a blocked upgrade falls back and recovers when the old tab closes', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const name = 'soundsible-playback-traces';
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('batches', { keyPath: 'id' });
    const old = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result); });
    const { PlaybackTraceOutbox } = await import('/player/src/lib/playbackTraceOutbox.ts');
    const outbox = new PlaybackTraceOutbox('a');
    const nativeOpen = indexedDB.open.bind(indexedDB);
    let opens = 0;
    indexedDB.open = ((...args: Parameters<typeof indexedDB.open>) => {
      opens++;
      return nativeOpen(...args);
    }) as typeof indexedDB.open;
    await outbox.put({ id: 'fallback', userId: 'a', createdAt: Date.now(), capture: {}, dropped: 0, events: [{}] });
    for (let i = 0; i < 10; i++) {
      await outbox.maintain();
      await outbox.pending();
    }
    const whileBlocked = opens;
    old.close();
    const ready = nativeOpen(name, 2);
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      ready.onsuccess = () => resolve(ready.result);
      ready.onerror = () => reject(ready.error);
    });
    upgraded.close();
    await outbox.put({ id: 'persistent', userId: 'a', createdAt: Date.now(), capture: {}, dropped: 0, events: [{}] });
    const merged = await outbox.pending();
    const nativeTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof nativeTransaction>) {
      const tx = nativeTransaction.apply(this, args);
      if (args[1] === 'readwrite') tx.abort();
      return tx;
    } as typeof nativeTransaction;
    await outbox.remove('persistent');
    IDBDatabase.prototype.transaction = nativeTransaction;
    const retained = await outbox.pending();
    indexedDB.open = nativeOpen;
    return { whileBlocked, merged: merged.map((b: { id: string }) => b.id), retained: retained.map((b: { id: string }) => b.id) };
  });
  expect(result.whileBlocked).toBe(1);
  expect(result.merged).toEqual(['fallback', 'persistent']);
  expect(result.retained).toEqual(['fallback', 'persistent']);
});
