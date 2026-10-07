import { expect, it, vi } from 'vitest';
import { createAccountRefresh } from './accountRefresh';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
it('joins pending refreshes and waits for the queued observation before releasing callers', async () => {
  const first = deferred(), second = deferred();
  const run = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const refresh = createAccountRefresh(run, () => 1, () => true);
  const one = refresh(), two = refresh(); let complete = false; void two.then(() => { complete = true; });
  expect(one).toBe(two); expect(run).toHaveBeenCalledOnce();
  first.resolve(); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect(complete).toBe(false);
  second.resolve(); await two; expect(complete).toBe(true);
});
it('an old account cannot trigger another load or release a replacement account', async () => {
  const old = deferred(), next = deferred(); let identity = 1;
  const run = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  const refresh = createAccountRefresh(run, () => identity, () => true);
  const before = refresh(); refresh(); identity = 2;
  const after = refresh(); expect(after).not.toBe(before);
  old.resolve(); await before; expect(run).toHaveBeenCalledTimes(2);
  expect(refresh()).toBe(after);
  run.mockResolvedValue(undefined); next.resolve(); await after;
  expect(run).toHaveBeenCalledTimes(3);
});
