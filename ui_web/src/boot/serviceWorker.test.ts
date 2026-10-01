// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const origin = 'http://station.test';
const template = readFileSync(new URL('../../public/sw.js', import.meta.url).pathname, 'utf8');
const key = (request: string | Request) => new URL(typeof request === 'string' ? request : request.url, origin).href;
class Cache {
  entries = new Map<string, Response>();
  fail = false;
  headers = new Map<string, Headers>();
  async match(request: string | Request, options?: { ignoreVary?: boolean }) {
    const response = this.entries.get(key(request));
    const incoming = new Headers(typeof request === 'string' ? undefined : request.headers);
    const stored = this.headers.get(key(request));
    if (!options?.ignoreVary && response?.headers.get('Vary')?.split(',').some(name => incoming.get(name.trim()) !== stored?.get(name.trim()))) return;
    return response?.clone();
  }
  async put(request: string | Request, response: Response) {
    if (this.fail) throw new Error('quota');
    this.entries.set(key(request), response.clone());
    this.headers.set(key(request), new Headers(typeof request === 'string' ? undefined : request.headers));
  }
  async delete(request: string | Request) { return this.entries.delete(key(request)); }
}
class Storage {
  caches = new Map<string, Cache>();
  async keys() { return [...this.caches.keys()]; }
  async open(name: string) {
    if (!this.caches.has(name)) this.caches.set(name, new Cache());
    return this.caches.get(name)!;
  }
  async delete(name: string) { return this.caches.delete(name); }
}
function worker(storage = new Storage(), letter = 'a', sizes: Record<string, number> = {}) {
  const build = letter.repeat(64);
  const core = '/player/assets/core.js';
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const fetch = vi.fn(async (_request: string | Request, _options?: RequestInit): Promise<Response> => {
    const url = key(_request);
    if (url === origin + '/player/') return new Response(`<meta name="soundsible-build" content="${build}"><div>shell</div>`);
    return new Response('asset');
  });
  const self = { location: { origin }, addEventListener: (name: string, fn: (event: Record<string, unknown>) => void) => listeners.set(name, fn),
    skipWaiting: vi.fn(async () => {}), clients: { claim: vi.fn(async () => {}) } };
  class BrowserRequest extends Request {
    constructor(input: string | Request, options?: RequestInit) { super(typeof input === 'string' ? key(input) : input, options); }
  }
  runInNewContext(template.replace('__BUILD_ID__', build).replace('__CORE_ASSETS__', JSON.stringify([core]))
    .replace('__ASSET_SIZES__', JSON.stringify({ [core]: 5, ...sizes })),
  { self, caches: storage, fetch, Request: BrowserRequest, Response, URL, TextEncoder, AbortController, setTimeout, clearTimeout });
  async function dispatch(type: string, event: Record<string, unknown> = {}) {
    const waits: Promise<unknown>[] = [];
    let reply: Promise<Response> | undefined;
    listeners.get(type)!({ ...event, waitUntil: (promise: Promise<unknown>) => waits.push(promise), respondWith: (promise: Promise<Response>) => { reply = promise; } });
    const response = reply ? await reply : undefined;
    await Promise.all(waits);
    return response;
  }
  const request = (path: string, options?: RequestInit) => new BrowserRequest(path, options);
  return { dispatch, storage, fetch, request, self, name: 'soundsible-shell-' + build };
}

it('retains two complete generations and never deletes another app cache', async () => {
  const storage = new Storage();
  await storage.open('another-app');
  await storage.open('soundsible-shell-v1');
  for (const letter of ['a', 'b', 'c']) {
    const app = worker(storage, letter);
    await app.dispatch('install');
    await app.dispatch('activate');
  }
  expect(await storage.keys()).toEqual(['another-app', 'soundsible-shell-' + 'b'.repeat(64), 'soundsible-shell-' + 'c'.repeat(64)]);
});

it('rejects a partial installation without replacing the previous shell', async () => {
  const storage = new Storage();
  const previous = worker(storage);
  await previous.dispatch('install');
  const next = worker(storage, 'b');
  next.fetch.mockImplementation(async request => key(request).endsWith('/core.js') ? new Response('', { status: 503 })
    : new Response(`<meta name="soundsible-build" content="${'b'.repeat(64)}">`));
  await expect(next.dispatch('install')).rejects.toThrow('dependency');
  expect(next.self.skipWaiting).not.toHaveBeenCalled();
  expect(await storage.keys()).toEqual([previous.name]);
});

it('bounds retained bodies, evicts optional assets, and keeps the bootstrap pinned', async () => {
  const one = '/player/assets/one.js', two = '/player/assets/two.js';
  const app = worker(undefined, 'a', { [one]: 5 * 1024 * 1024, [two]: 5 * 1024 * 1024 });
  await app.dispatch('install');
  for (const path of [one, two]) expect(await (await app.dispatch('fetch', { request: app.request(path) }))!.text()).toBe('asset');
  const cache = await app.storage.open(app.name);
  expect(await cache.match(one)).toBeUndefined();
  expect(await cache.match(two)).toBeDefined();
  expect(await cache.match('/player/assets/core.js')).toBeDefined();
  const state = await (await cache.match('/player/__shell_cache_state__'))!.json();
  expect(state.entries.reduce((sum: number, entry: { size: number }) => sum + entry.size, 0)).toBeLessThanOrEqual(8 * 1024 * 1024);
});

it('bounds entry count and refuses an individually oversized optional asset', async () => {
  const sizes = Object.fromEntries(Array.from({ length: 260 }, (_, index) => [`/player/assets/${index}.js`, 5]));
  sizes['/player/assets/oversized.js'] = 9 * 1024 * 1024;
  const app = worker(undefined, 'a', sizes);
  await app.dispatch('install');
  for (const path of Object.keys(sizes)) await app.dispatch('fetch', { request: app.request(path) });
  const cache = await app.storage.open(app.name);
  expect(cache.entries.size).toBe(257); // 256 bodies and one small metadata record.
  expect(await cache.match('/player/assets/oversized.js')).toBeUndefined();
  expect(await cache.match('/player/')).toBeDefined();
});

it('storage failures preserve successful network responses', async () => {
  const app = worker();
  await app.dispatch('install');
  (await app.storage.open(app.name)).fail = true;
  const response = await app.dispatch('fetch', { request: app.request('/player/branding/logo.svg') });
  expect(await response!.text()).toBe('asset');
});

it('adopts first-visit assets and ignores API, desktop, ranges and foreign messages', async () => {
  const path = '/player/assets/visited.js';
  const app = worker(undefined, 'a', { [path]: 5 });
  await app.dispatch('install');
  await app.dispatch('message', { source: { url: origin + '/player/' }, data: { type: 'soundsible-cache-used', urls: [origin + path, origin + '/api/library'] } });
  expect(await (await app.storage.open(app.name)).match(path)).toBeDefined();
  for (const path of ['/api/library', '/socket.io/', '/player/desktop/', '/player/assets/core.js']) {
    const options = path.endsWith('.js') ? { headers: { Range: 'bytes=0-1' } } : undefined;
    expect(await app.dispatch('fetch', { request: app.request(path, options) })).toBeUndefined();
  }
  expect(app.fetch.mock.calls.map(call => key(call[0]))).not.toContain(origin + '/api/library');
});

it('serves the previous exact hashed resource to an open page after an update', async () => {
  const storage = new Storage(), path = '/player/assets/old-route.js';
  const old = worker(storage, 'a', { [path]: 5 });
  await old.dispatch('install');
  await old.dispatch('fetch', { request: old.request(path) });
  const next = worker(storage, 'b');
  await next.dispatch('install');
  await next.dispatch('activate');
  next.fetch.mockRejectedValue(new Error('offline'));
  expect(await (await next.dispatch('fetch', { request: next.request(path) }))!.text()).toBe('asset');
});

describe('navigation', () => {
  it('uses the completed shell when the network fails', async () => {
    const app = worker();
    await app.dispatch('install');
    app.fetch.mockRejectedValue(new Error('offline'));
    const request = app.request('/player/');
    Object.defineProperty(request, 'mode', { value: 'navigate' });
    expect(await (await app.dispatch('fetch', { request }))!.text()).toContain('shell');
  });
  it('does not overwrite a complete shell with a different build', async () => {
    const app = worker();
    await app.dispatch('install');
    app.fetch.mockResolvedValue(new Response(`<meta name="soundsible-build" content="${'b'.repeat(64)}">new`));
    const request = app.request('/player/');
    Object.defineProperty(request, 'mode', { value: 'navigate' });
    expect(await (await app.dispatch('fetch', { request }))!.text()).toContain('new');
    expect(await (await (await app.storage.open(app.name)).match('/player/'))!.text()).toContain('shell');
  });
});


it('reopens bootstrap assets offline across encoding and Origin variants', async () => {
  const w = worker();
  w.fetch.mockImplementation(async request => key(request).endsWith('/player/')
    ? new Response(`<meta name="soundsible-build" content="${'a'.repeat(64)}">`)
    : new Response('asset', { headers: { Vary: 'Origin, Accept-Encoding' } }));
  await w.dispatch('install');
  w.fetch.mockRejectedValue(new Error('offline'));
  const response = await w.dispatch('fetch', { request: w.request('/player/assets/core.js', { headers: { Origin: origin, 'Accept-Encoding': 'br' } }) });
  expect(await response!.text()).toBe('asset');
  expect(w.fetch).toHaveBeenCalledTimes(2);
});
