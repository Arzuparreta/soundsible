/** Offline shell generations; never cache account data or media. Build substitutes the manifest. */
const BUILD = '__BUILD_ID__';
const CORE = __CORE_ASSETS__;
const ASSET_SIZES = __ASSET_SIZES__;
const PREFIX = 'soundsible-shell-';
const CACHE = PREFIX + BUILD;
const LEGACY = 'soundsible-shell-v1';
const SHELL_URL = '/player/';
const STATE_URL = '/player/__shell_cache_state__';
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 256;
const NAVIGATION_TIMEOUT_MS = 3500;
const coreUrls = new Set([SHELL_URL, ...CORE]);
let writes = Promise.resolve();

function serialize(task) {
  const next = writes.then(task);
  writes = next.catch(() => {});
  return next;
}
function bypassed(url) {
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')
    || url.pathname.startsWith('/player/desktop');
}
function immutable(url) { return url.pathname.startsWith('/player/assets/'); }
function revalidated(url) {
  return url.pathname.startsWith('/player/icons/') || url.pathname.startsWith('/player/branding/')
    || url.pathname === '/player/manifest.webmanifest';
}
function owned(name) { return name === LEGACY || /^soundsible-shell-[a-f0-9]{64}$/.test(name); }
async function readState(cache) {
  try {
    const response = await cache.match(STATE_URL);
    return response ? await response.json() : null;
  } catch { return null; }
}
async function writeState(cache, state) {
  await cache.put(STATE_URL, new Response(JSON.stringify(state), { headers: { 'Content-Type': 'application/json' } }));
}
async function generations() {
  const names = (await caches.keys()).filter(name => owned(name) && name !== LEGACY);
  const entries = await Promise.all(names.map(async (name, order) => ({ name, order, state: await readState(await caches.open(name)) })));
  return entries.filter(entry => entry.state?.ready).sort((a, b) => b.state.created - a.state.created || b.order - a.order);
}
async function cached(request) {
  try {
  const entries = await generations();
  entries.sort((a, b) => Number(b.name === CACHE) - Number(a.name === CACHE));
  for (const entry of entries) {
    const response = await (await caches.open(entry.name)).match(request);
    if (response) return response;
  }
  } catch { /* unavailable storage must not block a network response */ }
}
function buildOf(html) {
  return html.match(/<meta name="soundsible-build" content="([a-f0-9]{64})"/i)?.[1];
}
async function sizeOf(url, response) {
  if (url.pathname in ASSET_SIZES) return ASSET_SIZES[url.pathname];
  // Stable branding is served outside dist; stop reading if it exceeds admission.
  const reader = response.clone().body?.getReader();
  if (!reader) return 0;
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return size;
    size += value.byteLength;
    if (size > MAX_BYTES) { void reader.cancel(); return size; }
  }
}
async function storeOptional(request, response) {
  if (!response.ok || response.status === 206) return;
  const url = new URL(request.url || request, self.location.origin);
  if (!(immutable(url) || revalidated(url)) || bypassed(url)) return;
  const cache = await caches.open(CACHE);
  const state = await readState(cache);
  if (!state?.ready) return;
  const size = await sizeOf(url, response);
  if (size > MAX_BYTES) return;
  const key = url.href;
  const existing = state.entries.find(entry => entry.url === key);
  const next = state.entries.filter(entry => entry.url !== key);
  const pin = coreUrls.has(url.pathname);
  next.push({ url: key, size, pin });
  let bytes = next.reduce((total, entry) => total + entry.size, 0);
  while (bytes > MAX_BYTES || next.length > MAX_ENTRIES) {
    const index = next.findIndex(entry => !entry.pin && entry.url !== key);
    if (index < 0) return;
    const [entry] = next.splice(index, 1);
    bytes -= entry.size;
    await cache.delete(entry.url);
  }
  try {
    await cache.put(request, response);
    state.entries = next;
    await writeState(cache, state);
  } catch {
    // Storage failure never changes the network response or a completed shell.
    if (!existing) await cache.delete(key).catch(() => {});
  }
}

self.addEventListener('install', event => {
  event.waitUntil(serialize(async () => {
    const cache = await caches.open(CACHE);
    if ((await readState(cache))?.ready) { await self.skipWaiting(); return; }
    try {
      const shell = await fetch(new Request(SHELL_URL, { cache: 'reload' }));
      if (!shell.ok) throw new Error('shell unavailable');
      const html = await shell.clone().text();
      if (buildOf(html) !== BUILD) throw new Error('deployment changed during install');
      const entries = [{ url: new URL(SHELL_URL, self.location.origin).href, size: new TextEncoder().encode(html).length, pin: true }];
      // These are bootstrap dependencies only; authenticated views and locales stay lazy.
      for (const path of CORE) {
        const response = await fetch(path);
        if (!response.ok) throw new Error('shell dependency unavailable');
        entries.push({ url: new URL(path, self.location.origin).href, size: ASSET_SIZES[path], pin: true });
        if (entries.length > MAX_ENTRIES || entries.reduce((sum, entry) => sum + entry.size, 0) > MAX_BYTES) throw new Error('shell exceeds budget');
        await cache.put(path, response);
      }
      await cache.put(SHELL_URL, shell);
      await writeState(cache, { ready: true, created: Date.now(), entries });
      await self.skipWaiting();
    } catch (error) {
      // Reject this installation; the previous complete worker remains available.
      await caches.delete(CACHE);
      throw error;
    }
  }));
});
self.addEventListener('activate', event => {
  event.waitUntil(serialize(async () => {
    const complete = await generations();
    const previous = complete.find(entry => entry.name !== CACHE)?.name;
    for (const name of await caches.keys()) {
      if (owned(name) && name !== CACHE && name !== previous) await caches.delete(name);
    }
    await self.clients.claim();
  }));
});

function fetchWithTimeout(request, milliseconds) {
  const aborter = new AbortController();
  const timer = setTimeout(() => aborter.abort(), milliseconds);
  return fetch(request, { signal: aborter.signal }).finally(() => clearTimeout(timer));
}
async function navigation(event) {
  try {
    const response = await fetchWithTimeout(event.request, NAVIGATION_TIMEOUT_MS);
    if (response.ok) event.waitUntil(serialize(async () => {
      const html = await response.clone().text();
      if (buildOf(html) !== BUILD) return;
      const cache = await caches.open(CACHE);
      const state = await readState(cache);
      if (state?.ready) await cache.put(SHELL_URL, response.clone());
    }).catch(() => {}));
    return response;
  } catch {
    const response = await cached(SHELL_URL);
    if (response) return response;
    throw new Error('offline and no complete shell');
  }
}
async function asset(event) {
  const response = await cached(event.request);
  if (response) return response;
  const network = await fetch(event.request);
  event.waitUntil(serialize(() => storeOptional(event.request, network.clone())).catch(() => {}));
  return network;
}
async function stableAsset(event) {
  const response = await cached(event.request);
  const network = fetch(event.request).then(async fresh => {
    if (fresh.ok) await serialize(() => storeOptional(event.request, fresh.clone())).catch(() => {});
    return fresh;
  }).catch(() => undefined);
  event.waitUntil(network);
  if (response) return response;
  const fresh = await network;
  if (fresh) return fresh;
  throw new Error('offline and resource not cached');
}
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('Range')) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || bypassed(url)) return;
  if (request.mode === 'navigate') event.respondWith(navigation(event));
  else if (immutable(url)) event.respondWith(asset(event));
  else if (revalidated(url)) event.respondWith(stableAsset(event));
});

/** Adopt resources already used before the first page acquired a controller. */
self.addEventListener('message', event => {
  if (event.data?.type !== 'soundsible-cache-used' || !Array.isArray(event.data.urls)) return;
  const source = event.source?.url && new URL(event.source.url);
  if (!source || source.origin !== self.location.origin || !source.pathname.startsWith('/player/') || bypassed(source)) return;
  event.waitUntil(serialize(async () => {
    for (const value of event.data.urls.slice(0, MAX_ENTRIES)) {
      if (typeof value !== 'string') continue;
      const url = new URL(value, self.location.origin);
      if (url.origin !== self.location.origin || !(url.pathname in ASSET_SIZES) || bypassed(url)) continue;
      const request = new Request(url.href);
      const cache = await caches.open(CACHE);
      if (await cache.match(request)) continue;
      const response = await fetch(request).catch(() => undefined);
      if (response) await storeOptional(request, response);
    }
  }).catch(() => {}));
});
