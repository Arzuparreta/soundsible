/** Every caller waits for the latest queued refresh of its own account. */
export function createAccountRefresh(run: () => Promise<void>, identity: () => number, ready: () => boolean): () => Promise<void> {
  let active: { identity: number; queued: boolean; promise: Promise<void> } | null = null;
  return () => {
    if (!ready()) return Promise.resolve();
    const account = identity();
    if (active?.identity === account) { active.queued = true; return active.promise; }
    const state = { identity: account, queued: false, promise: Promise.resolve() };
    active = state;
    state.promise = (async () => {
      try {
        do {
          state.queued = false;
          await run();
        } while (state.queued && identity() === account && ready());
      } finally { if (active === state) active = null; }
    })();
    return state.promise;
  };
}
