import { afterEach, expect, it, vi } from 'vitest';
import { request, setDjWork } from './http';

afterEach(() => { setDjWork(undefined); vi.unstubAllGlobals(); });

it('pins the work epoch to a request and sends cancellation to that same epoch', async () => {
  const calls: RequestInit[] = [];
  const fetcher = vi.fn((_url: string, init: RequestInit) => {
    calls.push(init);
    if (calls.length > 1) return Promise.resolve(new Response('{}'));
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  });
  vi.stubGlobal('fetch', fetcher);
  setDjWork({ client: 'browser', epoch: 1 });
  const aborter = new AbortController();
  const result = request('/api/discovery/music/dj-plan', { method: 'POST', body: {}, signal: aborter.signal });
  setDjWork({ client: 'browser', epoch: 2 });
  aborter.abort();
  await expect(result).rejects.toThrow('aborted');
  const original = calls[0].headers as Record<string, string>;
  const cancellation = calls[1].headers as Record<string, string>;
  expect(JSON.parse(cancellation['X-Soundsible-Work'])).toEqual({ client: 'browser', epoch: 1 });
  expect(JSON.parse(String(calls[1].body))).toEqual({ cancel_request: original['X-Soundsible-Work-Request'] });
});

it('keeps completed requests settled when their caller is disposed later', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetcher);
  setDjWork({ client: 'browser', epoch: 1 });
  const aborter = new AbortController();
  await request('/api/discovery/music/dj-plan', { signal: aborter.signal });
  aborter.abort();
  expect(fetcher).toHaveBeenCalledOnce();
});

it('identifies DJ requests on plain HTTP without randomUUID', async () => {
  const values = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  vi.stubGlobal('crypto', { getRandomValues: values });
  const fetcher = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetcher);
  setDjWork({ client: 'lan-browser', epoch: 1 });
  await request('/api/discovery/music/dj-plan');
  const headers = fetcher.mock.calls[0][1].headers as Record<string, string>;
  expect(headers['X-Soundsible-Work-Request']).toMatch(/^[a-f0-9-]{36}$/);
});
