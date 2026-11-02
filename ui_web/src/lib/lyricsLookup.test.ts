import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './http';
import { lookupLyrics } from './lyricsLookup';
import type { LyricsResponse } from '../types/music';

const unavailable: LyricsResponse = {
  status: 'unavailable', pending: false, synced: null, plain: null, instrumental: false, cached: false,
};
const pending: LyricsResponse = { ...unavailable, status: 'pending', pending: true };
const ready: LyricsResponse = { ...unavailable, status: 'ready', plain: 'Recovered lyrics' };

describe('lyrics recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    ready,
    { ...unavailable, status: 'not_found' as const },
    { ...ready, plain: null, instrumental: true },
  ])('returns a conclusive $status answer immediately', async (answer) => {
    const request = vi.fn().mockResolvedValue(answer);
    await expect(lookupLyrics(request, new AbortController().signal)).resolves.toBe(answer);
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers failed engine jobs automatically and polls pending jobs without starting duplicates', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(ready);
    const result = lookupLyrics(request, new AbortController().signal);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual(ready);
    expect(request).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 300, 1_500, 4_000])('recovers an eight-second failed job with %i ms API latency', async (latency) => {
    // The first engine job fails; the next succeeds. Each job keeps its
    // original eight-second bound, regardless of API round-trip duration.
    let jobs = 0;
    let finishesAt: number | null = null;
    const request = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, latency));
      if (finishesAt === null) {
        jobs += 1;
        finishesAt = Date.now() + 8_000;
        return pending;
      }
      if (Date.now() < finishesAt) return pending;
      finishesAt = null;
      return jobs === 1 ? unavailable : ready;
    });
    const result = lookupLyrics(request, new AbortController().signal);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual(ready);
    expect(jobs).toBe(2);
    expect(request.mock.calls.length).toBeLessThan(40);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('backs off a continuous outage and stops at one minute with manual retry still possible', async () => {
    const began = Date.now();
    const starts: number[] = [];
    const request = vi.fn(async () => { starts.push(Date.now() - began); return unavailable; });
    const result = lookupLyrics(request, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toEqual(unavailable);
    expect(starts).toEqual([0, 2_000, 6_000, 14_000, 22_000, 30_000, 38_000, 46_000, 54_000]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(9);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps busy/pending polling below the metadata endpoint limit and stops it at the deadline', async () => {
    const request = vi.fn().mockResolvedValue(pending);
    const result = lookupLyrics(request, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toEqual(unavailable);
    expect(request).toHaveBeenCalledTimes(41);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    new TypeError('Failed to fetch'),
    new DOMException('Request timed out', 'AbortError'),
    new ApiError(408, 'Request timed out'),
    new ApiError(429, 'Too many requests'),
    new ApiError(502, 'Bad gateway'),
    new ApiError(503, 'Unavailable'),
  ])('recovers temporary transport errors: $name $message', async (error) => {
    const request = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(ready);
    const result = lookupLyrics(request, new AbortController().signal);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual(ready);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    new ApiError(401, 'Login required'),
    new ApiError(403, 'Forbidden'),
    new ApiError(404, 'Track removed'),
    new SyntaxError('Invalid response'),
  ])('does not retry permanent errors: $message', async (error) => {
    const request = vi.fn().mockRejectedValue(error);
    await expect(lookupLyrics(request, new AbortController().signal)).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers slow transport timeouts within the same total deadline', async () => {
    let calls = 0;
    const request = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      if (++calls < 3) throw new DOMException('Request timed out', 'AbortError');
      return ready;
    });
    const began = Date.now();
    const result = lookupLyrics(request, new AbortController().signal);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual(ready);
    expect(Date.now() - began).toBe(51_000);
    expect(request).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([pending, unavailable])('cancels during a $status wait without another request', async (answer) => {
    const abort = new AbortController();
    const request = vi.fn().mockResolvedValue(answer);
    const result = lookupLyrics(request, abort.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(100);
    abort.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts an in-flight request at the same deadline as polling and backoff', async () => {
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn((signal: AbortSignal) => new Promise<LyricsResponse>((_, reject) => {
      requestSignal = signal;
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const result = lookupLyrics(request, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toEqual(unavailable);
    expect(requestSignal?.aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start work for an already cancelled song', async () => {
    const abort = new AbortController();
    abort.abort();
    const request = vi.fn();
    await expect(lookupLyrics(request, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
