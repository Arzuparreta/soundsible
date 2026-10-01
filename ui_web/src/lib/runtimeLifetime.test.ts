import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeLifetime } from './runtimeLifetime';

afterEach(() => vi.useRealTimers());

it('removes listeners and timers once and rejects callbacks from previous instances', () => {
  vi.useFakeTimers();
  const lifetime = new RuntimeLifetime();
  const listener = vi.fn();
  const cleanup = vi.fn();
  const oldReply = lifetime.guard(listener);
  lifetime.listen(window, 'click', listener);
  lifetime.setTimeout(listener, 100);
  lifetime.setInterval(listener, 100);
  lifetime.own(cleanup);
  lifetime.close();
  lifetime.close();
  expect(cleanup).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new Event('click'));
  vi.advanceTimersByTime(1000);
  oldReply();
  expect(listener).not.toHaveBeenCalled();
  lifetime.start();
  lifetime.listen(window, 'click', listener);
  window.dispatchEvent(new Event('click'));
  oldReply();
  expect(listener).toHaveBeenCalledTimes(1);
  lifetime.close();
});
