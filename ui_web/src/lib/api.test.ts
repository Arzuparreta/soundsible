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


describe('library revision HTTP contract', () => {
  it('returns the validator and sends it only when supplied by the store', async () => {
    const { api } = await import('./api');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"tracks":[]}', { headers: { ETag: 'W/"a"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(new Response('{"tracks":[]}'));
    globalThis.fetch = fetchMock;
    expect(await api.getLibrary()).toEqual({ tracks: [], revision: 'W/"a"' });
    expect(await api.getLibrary('W/"a"')).toBeNull();
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      headers: { 'If-None-Match': 'W/"a"' }, cache: 'no-store', credentials: 'same-origin',
    });
    expect(await api.getLibrary()).toEqual({ tracks: [], revision: undefined });
    expect(fetchMock.mock.calls[2][1].headers).not.toHaveProperty('If-None-Match');
  });

  it('does not mistake failures or an unsolicited 304 for an unchanged snapshot', async () => {
    const { api } = await import('./api');
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(new Response('offline', { status: 503 }));
    await expect(api.getLibrary()).rejects.toMatchObject({ status: 304 });
    await expect(api.getLibrary('W/"a"')).rejects.toMatchObject({ status: 503 });
  });
});

it.each(['', 'null', '{}', '{"tracks":null}'])('rejects malformed full library response %s instead of clearing the accepted snapshot', async body => {
  const { api } = await import('./api');
  globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(body, { headers: { ETag: 'W/"broken"' } }));
  await expect(api.getLibrary('W/"previous"')).rejects.toThrow('Invalid library snapshot');
});

it('opts into disk-backed deltas with the accepted revision as the explicit base', async () => {
  const { api } = await import('./api');
  const revision = 'a'.repeat(64);
  const delta = { kind: 'delta', base_revision: revision, revision: 'b'.repeat(64), upserts: [], removed: [], fields: {} };
  globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(delta)));
  expect(await api.getLibrary(`W/"${revision}"`)).toEqual(delta);
  const [url, options] = vi.mocked(globalThis.fetch).mock.calls[0];
  expect(String(url)).toContain(`/api/library?delta=1&since=${revision}`);
  expect(options?.headers).toMatchObject({ 'If-None-Match': `W/"${revision}"` });
});
