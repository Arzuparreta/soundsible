import { describe, expect, it, vi, afterEach } from 'vitest';
import { request } from './api';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

/**
 * Capture the RequestInit `request()` hands to fetch, and otherwise never
 * resolve — the point of these tests is what happens while a request is
 * outstanding. Models the one piece of real `fetch` semantics that matters
 * here: a signal that is *already* aborted rejects immediately, rather than
 * waiting for an `abort` event that has come and gone.
 */
function hangingFetch(): { init: () => RequestInit } {
  let captured: RequestInit = {};
  globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    captured = init ?? {};
    const abortError = () => new DOMException('Aborted', 'AbortError');
    if (init?.signal?.aborted) return Promise.reject(abortError());
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(abortError()));
    });
  }) as typeof fetch;
  return { init: () => captured };
}

describe('request abort handling', () => {
  it('still times out when the caller supplies its own signal', async () => {
    // Regression: the caller's signal used to be passed straight to fetch,
    // which silently discarded the timeout. Every debounced search — the only
    // calls that pass a signal — could then hang indefinitely.
    vi.useFakeTimers();
    hangingFetch();
    const caller = new AbortController();

    const pending = request('/api/test', { signal: caller.signal, timeoutMs: 1000 });
    const assertion = expect(pending).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('aborts as soon as the caller does, without waiting for the timeout', async () => {
    vi.useFakeTimers();
    hangingFetch();
    const caller = new AbortController();

    const pending = request('/api/test', { signal: caller.signal, timeoutMs: 60_000 });
    const assertion = expect(pending).rejects.toThrow();

    caller.abort();
    await assertion;
  });

  it('honours a signal that was already aborted before the call', async () => {
    hangingFetch();
    const caller = new AbortController();
    caller.abort();

    await expect(request('/api/test', { signal: caller.signal })).rejects.toThrow();
  });

  it('drives fetch from one signal so both reasons to give up apply', () => {
    const captured = hangingFetch();
    const caller = new AbortController();

    void request('/api/test', { signal: caller.signal }).catch(() => {});

    // Not the caller's signal: an internal one that follows both the caller
    // and the deadline.
    expect(captured.init().signal).toBeDefined();
    expect(captured.init().signal).not.toBe(caller.signal);
  });
});
