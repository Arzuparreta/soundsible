import { afterEach, describe, expect, it, vi } from 'vitest';
import { Lifetime } from './lifetime';

afterEach(() => vi.useRealTimers());
describe('session resource ownership', () => {
  it('tears down repeated sessions without duplicate events or orphan timers', () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    const listener = vi.fn();
    const tick = vi.fn();
    for (let session = 0; session < 100; session += 1) {
      const lifetime = new Lifetime();
      lifetime.listen(target, 'resume', listener);
      lifetime.interval(tick, 1000);
      lifetime.timeout(tick, 5000);
      target.dispatchEvent(new Event('resume'));
      lifetime.dispose();
      lifetime.dispose();
    }
    vi.advanceTimersByTime(60_000);
    target.dispatchEvent(new Event('resume'));
    expect(listener).toHaveBeenCalledTimes(100);
    expect(tick).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
