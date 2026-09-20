import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../types/music';
import type { PreviewPreparation } from './api';
import { PreviewPrefetch, upcomingPreviewIds } from './prefetch';

const preview = (id: string): Track => ({ id, title: id, artist: 'A', source: 'preview' });
const local = (id: string): Track => ({ id, title: id, artist: 'A' });
const podcast = (id: string): Track => ({
  id,
  title: id,
  artist: 'A',
  source: 'preview',
  podcast_episode_guid: id,
});

describe('upcomingPreviewIds', () => {
  it('collects the next previews in linear order, skipping local tracks and podcasts', () => {
    const queue = [local('l1'), podcast('p0'), preview('v1'), local('l2'), preview('v2'), preview('v3')];
    expect(upcomingPreviewIds(queue, 0, false)).toEqual(['v1', 'v2']);
  });

  it('stops at the end of the queue unless repeat-all wraps around', () => {
    const queue = [preview('v1'), local('l1'), preview('v2')];
    expect(upcomingPreviewIds(queue, 2, false)).toEqual([]);
    expect(upcomingPreviewIds(queue, 2, true)).toEqual(['v1']);
  });

  it('handles an empty queue', () => {
    expect(upcomingPreviewIds([], 0, true)).toEqual([]);
  });
});


type Response = { preparation?: Record<string, PreviewPreparation> };
const id = (n: number) => String(n).padStart(11, '0');
const rows = (ids: string[], state: PreviewPreparation['state']): Response => ({
  preparation: Object.fromEntries(ids.map(value => [value, { state }])),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('owned preview preparation', () => {
  let client: {
    prefetchPreviews: ReturnType<typeof vi.fn<(ids: string[], download?: boolean) => Promise<Response>>>;
    previewStatuses: ReturnType<typeof vi.fn<(ids: string[]) => Promise<Response>>>;
  };
  let cache: PreviewPrefetch;
  let visible: boolean;
  const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    visible = true;
    client = {
      prefetchPreviews: vi.fn(async ids => rows(ids, 'pending')),
      previewStatuses: vi.fn(async ids => rows(ids, 'pending')),
    };
    cache = new PreviewPrefetch(client, () => visible);
  });
  afterEach(() => {
    cache.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('filters, deduplicates, limits and expires speculative warming', async () => {
    cache.warm([id(1), id(1), 'invalid', ...Array.from({ length: 20 }, (_, i) => id(i + 2))]);
    await tick();
    expect(client.prefetchPreviews).toHaveBeenCalledWith(Array.from({ length: 8 }, (_, i) => id(i + 1)), false);
    cache.warm([id(1)]);
    expect(client.prefetchPreviews).toHaveBeenCalledTimes(1);
    await tick(4 * 60_000);
    cache.warm([id(1)]);
    expect(client.prefetchPreviews).toHaveBeenCalledTimes(2);
  });

  it('releases failed warm attempts and allows downloads of warm IDs', async () => {
    client.prefetchPreviews.mockRejectedValueOnce(new Error('offline'));
    cache.warm([id(1)]);
    await tick();
    cache.warm([id(1)]);
    await tick();
    cache.owner(vi.fn()).update([id(1)]);
    await tick();
    expect(client.prefetchPreviews.mock.calls.map(c => c[1])).toEqual([false, false, true]);
  });

  it('retains measured progress without upgrading streamable to ready', async () => {
    const status: PreviewPreparation = { state: 'streamable', downloaded_bytes: 500, total_bytes: 1000, progress: .5 };
    client.prefetchPreviews.mockResolvedValue({ preparation: { [id(1)]: status } });
    const listener = vi.fn();
    const owner = cache.owner(listener);
    owner.update([id(1)]);
    await tick();
    owner.update([id(1)]);
    await tick();
    expect(cache.preparation(id(1))).toEqual(status);
    expect(client.prefetchPreviews).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(id(1), status);
  });

  it.each(['ready', 'unavailable'] as const)('does not put immediate %s back into fast polling', async state => {
    client.prefetchPreviews.mockImplementation(async ids => rows(ids, state));
    cache.owner(vi.fn()).update([id(1)]);
    await tick(5000);
    expect(cache.preparation(id(1))?.state).toBe(state);
    expect(client.previewStatuses).not.toHaveBeenCalled();
  });

  it('rotates all batches, including after errors, without overlapping requests', async () => {
    const held = deferred<Response>();
    const ids = Array.from({ length: 20 }, (_, n) => id(n));
    cache.owner(vi.fn()).update(ids);
    await tick(10);
    expect(client.prefetchPreviews).toHaveBeenCalledTimes(3);
    client.previewStatuses.mockReturnValueOnce(held.promise);
    await tick(1000);
    expect(client.previewStatuses).toHaveBeenCalledTimes(1);
    await tick(5000);
    expect(client.previewStatuses).toHaveBeenCalledTimes(1);
    held.reject(new Error('offline'));
    await tick(2010);
    const polled = new Set(client.previewStatuses.mock.calls.flatMap(c => c[0]));
    expect(polled.size).toBe(20);
    expect(client.previewStatuses.mock.calls.every(c => c[0].length <= 8)).toBe(true);
  });

  it('polls missing responses without accepting unsolicited IDs or claiming readiness', async () => {
    client.prefetchPreviews.mockResolvedValue({ preparation: { [id(99)]: { state: 'ready' } } });
    cache.owner(vi.fn()).update([id(1)]);
    await tick(1100);
    expect(cache.preparation(id(99))).toBeUndefined();
    expect(cache.preparation(id(1))?.state).toBe('pending');
    expect(client.previewStatuses).toHaveBeenCalledWith([id(1)]);
  });

  it('re-submits cold work and respects the absolute retry deadline', async () => {
    client.prefetchPreviews.mockResolvedValueOnce({ preparation: { [id(1)]: { state: 'cold', retry_after: 5 } } });
    cache.owner(vi.fn()).update([id(1)]);
    await tick();
    await tick(4999);
    expect(client.prefetchPreviews).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(client.prefetchPreviews).toHaveBeenCalledTimes(2);
  });

  it('disposal removes subscriptions and ignores late replies', async () => {
    const held = deferred<Response>();
    client.prefetchPreviews.mockReturnValueOnce(held.promise);
    const listener = vi.fn();
    const owner = cache.owner(listener);
    owner.update([id(1)]);
    await tick();
    owner.dispose();
    held.resolve(rows([id(1)], 'unavailable'));
    await tick();
    expect(listener).not.toHaveBeenCalled();
    expect(cache.preparation(id(1))).toBeUndefined();
    expect(cache.stats().subscriptions).toBe(0);
    await tick(2000);
    expect(client.previewStatuses).not.toHaveBeenCalled();
  });

  it('does not deliver an earlier generation to a re-added ID', async () => {
    const held = deferred<Response>();
    client.prefetchPreviews.mockReturnValueOnce(held.promise);
    const listener = vi.fn();
    const owner = cache.owner(listener);
    owner.update([id(1)]);
    await tick();
    owner.update([]);
    owner.update([id(1)]);
    held.resolve(rows([id(1)], 'unavailable'));
    await tick(2001);
    expect(listener.mock.calls.every(c => c[1].state !== 'unavailable')).toBe(true);
    expect(cache.preparation(id(1))?.state).toBe('pending');
  });

  it('shares acquisition while keeping distinct owners of the same callback', async () => {
    const listener = vi.fn();
    const a = cache.owner(listener);
    const b = cache.owner(listener);
    a.update([id(1)]);
    b.update([id(1)]);
    await tick();
    a.dispose();
    expect(cache.stats().subscriptions).toBe(1);
    client.previewStatuses.mockImplementation(async ids => rows(ids, 'ready'));
    await tick(1000);
    expect(client.prefetchPreviews).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(id(1), { state: 'ready' });
    b.dispose();
    expect(cache.stats().subscriptions).toBe(0);
  });

  it('caps all inactive metadata over 10000 IDs and expires it without further calls', async () => {
    client.prefetchPreviews.mockImplementation(async ids => rows(ids, 'ready'));
    const active = cache.owner(vi.fn());
    active.update([id(0)]);
    await tick();
    const owner = cache.owner(vi.fn());
    for (let n = 1; n <= 10000; n += 8) {
      owner.update(Array.from({ length: Math.min(8, 10001 - n) }, (_, i) => id(n + i)));
      await tick(1);
    }
    owner.dispose();
    expect(cache.stats()).toMatchObject({ inactive: 256, subscriptions: 1, entries: 257 });
    expect(cache.preparation(id(0))?.state).toBe('ready');
    expect(cache.preparation(id(1))).toBeUndefined();
    active.dispose();
    await tick(10 * 60_000);
    expect(cache.stats().entries).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('protects in-flight warm entries until completion then prunes them', async () => {
    const held = deferred<Response>();
    client.prefetchPreviews.mockReturnValue(held.promise);
    for (let n = 0; n < 300; n++) cache.warm([id(n)]);
    expect(cache.stats()).toMatchObject({ entries: 300, inFlight: 300 });
    held.resolve({});
    await tick();
    expect(cache.stats()).toMatchObject({ entries: 256, inFlight: 0 });
  });

  it('revalidates ready on reacquisition and after reconnect without destroying its last verdict', async () => {
    client.prefetchPreviews.mockImplementation(async ids => rows(ids, 'ready'));
    const owner = cache.owner(vi.fn());
    owner.update([id(1)]);
    await tick();
    owner.update([]);
    owner.update([id(1)]);
    client.previewStatuses.mockRejectedValueOnce(new Error('offline'));
    await tick();
    expect(cache.preparation(id(1))?.state).toBe('ready');
    client.previewStatuses.mockImplementation(async ids => rows(ids, 'cold'));
    owner.revalidate();
    await tick(1000);
    expect(cache.preparation(id(1))?.state).toBe('cold');
    await tick(2000);
    expect(client.prefetchPreviews).toHaveBeenCalledTimes(2);
  });

  it('revalidates visible ready every 30s, preserves hidden readiness and resumes explicitly', async () => {
    client.prefetchPreviews.mockImplementation(async ids => rows(ids, 'ready'));
    client.previewStatuses.mockImplementation(async ids => rows(ids, 'ready'));
    const owner = cache.owner(vi.fn());
    owner.update([id(1)]);
    await tick(30_000);
    expect(client.previewStatuses).toHaveBeenCalledTimes(1);
    visible = false;
    await tick(90_000);
    expect(client.previewStatuses).toHaveBeenCalledTimes(1);
    expect(cache.preparation(id(1))?.state).toBe('ready');
    owner.revalidate();
    await tick();
    expect(client.previewStatuses).toHaveBeenCalledTimes(2);
  });

  it('a revalidation supersedes an older response already in flight', async () => {
    const held = deferred<Response>();
    client.prefetchPreviews.mockReturnValueOnce(held.promise);
    const listener = vi.fn();
    const owner = cache.owner(listener);
    owner.update([id(1)]);
    await tick();
    owner.revalidate();
    held.resolve(rows([id(1)], 'unavailable'));
    await tick(1);
    expect(listener).not.toHaveBeenCalledWith(id(1), { state: 'unavailable' });
    expect(client.previewStatuses).toHaveBeenCalledWith([id(1)]);
  });
});
