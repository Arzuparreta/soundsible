import { afterEach, expect, it, vi } from 'vitest';
import { recoverConnection } from './connectionRecovery';

afterEach(() => { vi.useRealTimers(); });
it('keeps retrying past five failures, backs off, and wakes immediately on connectivity', async () => {
  vi.useFakeTimers();
  const attempt = vi.fn().mockResolvedValue(false);
  const stop = recoverConnection(attempt);
  await vi.advanceTimersByTimeAsync(64_000);
  expect(attempt).toHaveBeenCalledTimes(7);
  attempt.mockResolvedValue(true);
  window.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(0);
  expect(attempt).toHaveBeenCalledTimes(8);
  await vi.advanceTimersByTimeAsync(120_000);
  window.dispatchEvent(new Event('online'));
  expect(attempt).toHaveBeenCalledTimes(8);
  stop();
});
it('coalesces wakeups and never revives work after disposal', async () => {
  vi.useFakeTimers();
  let resolve!: (value: boolean) => void;
  const attempt = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
  const stop = recoverConnection(attempt);
  window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('pageshow'));
  expect(attempt).toHaveBeenCalledTimes(1);
  stop(); resolve(false);
  await vi.advanceTimersByTimeAsync(90_000);
  window.dispatchEvent(new Event('online'));
  expect(attempt).toHaveBeenCalledTimes(1);
});
