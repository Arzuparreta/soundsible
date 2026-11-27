import { createSignal } from 'solid-js';

export type TvRoute =
  | { name: 'home'; hash: string }
  | { name: 'search'; hash: string }
  | { name: 'library'; hash: string }
  | { name: 'now-playing'; hash: string }
  | { name: 'account'; hash: string }
  | {
      name: 'album';
      hash: string;
      albumId: string;
      albumName: string;
      artist: string;
      deezerId?: string;
      source: 'library' | 'catalog';
    }
  | { name: 'playlist'; hash: string; playlistName: string };

export interface TvHistoryEntry {
  hash: string;
  focusedId: string | null;
  scrollTop: number;
  shelfScrolls: Record<string, number>;
}

const ROOT_HASHES = new Set([
  '#/home',
  '#/search',
  '#/library',
  '#/now-playing',
  '#/account',
]);

export function parseTvHash(rawHash: string): TvRoute {
  const normalized = rawHash.startsWith('#') ? rawHash : `#${rawHash}`;
  const clean = normalized === '#' || normalized === '#/' || normalized === '' ? '#/home' : normalized;
  const [pathPart, queryPart = ''] = clean.slice(1).split('?');
  const path = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  const query = new URLSearchParams(queryPart);

  if (path === '/search') return { name: 'search', hash: clean };
  if (path === '/library') return { name: 'library', hash: clean };
  if (path === '/now-playing') return { name: 'now-playing', hash: clean };
  if (path === '/account') return { name: 'account', hash: clean };

  if (path.startsWith('/album/')) {
    const segment = path.slice('/album/'.length);
    const decoded = safeDecode(segment);
    return {
      name: 'album',
      hash: clean,
      albumId: decoded,
      albumName: query.get('name') || decoded,
      artist: query.get('artist') || '',
      deezerId: query.get('deezer_id') || undefined,
      source: query.get('source') === 'catalog' ? 'catalog' : 'library',
    };
  }

  if (path.startsWith('/playlist/')) {
    const segment = path.slice('/playlist/'.length);
    return {
      name: 'playlist',
      hash: clean,
      playlistName: safeDecode(segment),
    };
  }

  return { name: 'home', hash: '#/home' };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value).normalize('NFC');
  } catch {
    return value.normalize('NFC');
  }
}

export function albumTvHash(opts: {
  id: string;
  name?: string;
  artist?: string;
  deezerId?: string;
  source?: 'library' | 'catalog';
}): string {
  const params = new URLSearchParams();
  if (opts.name) params.set('name', opts.name);
  if (opts.artist) params.set('artist', opts.artist);
  if (opts.deezerId) params.set('deezer_id', opts.deezerId);
  if (opts.source === 'catalog') params.set('source', 'catalog');
  const qs = params.toString();
  return `#/album/${encodeURIComponent(opts.id)}${qs ? `?${qs}` : ''}`;
}

export function playlistTvHash(name: string): string {
  return `#/playlist/${encodeURIComponent(name.normalize('NFC'))}`;
}

export function createTvRouter(initialHash = typeof window !== 'undefined' ? window.location.hash : '#/home') {
  const startRoute = parseTvHash(initialHash);
  const [route, setRoute] = createSignal<TvRoute>(startRoute);
  const [stack, setStack] = createSignal<TvHistoryEntry[]>([
    { hash: startRoute.hash, focusedId: null, scrollTop: 0, shelfScrolls: {} },
  ]);

  function writeLocationHash(hash: string): void {
    if (typeof window === 'undefined') return;
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    }
  }

  function push(
    targetHash: string,
    snapshot?: { focusedId: string | null; scrollTop: number; shelfScrolls: Record<string, number> },
  ): void {
    const parsed = parseTvHash(targetHash);
    setStack((prev) => {
      const updated = prev.map((entry, idx) =>
        idx === prev.length - 1 && snapshot
          ? {
              ...entry,
              focusedId: snapshot.focusedId,
              scrollTop: snapshot.scrollTop,
              shelfScrolls: snapshot.shelfScrolls,
            }
          : entry,
      );
      return [
        ...updated,
        { hash: parsed.hash, focusedId: null, scrollTop: 0, shelfScrolls: {} },
      ];
    });
    setRoute(parsed);
    writeLocationHash(parsed.hash);
  }

  function replaceRoot(targetHash: string): void {
    const parsed = parseTvHash(targetHash);
    setStack([{ hash: parsed.hash, focusedId: null, scrollTop: 0, shelfScrolls: {} }]);
    setRoute(parsed);
    writeLocationHash(parsed.hash);
  }

  function pop(): TvHistoryEntry | null {
    const current = stack();
    if (current.length <= 1) {
      if (route().name !== 'home') {
        replaceRoot('#/home');
        return { hash: '#/home', focusedId: null, scrollTop: 0, shelfScrolls: {} };
      }
      return null;
    }
    const nextStack = current.slice(0, -1);
    const restored = nextStack[nextStack.length - 1];
    setStack(nextStack);
    setRoute(parseTvHash(restored.hash));
    writeLocationHash(restored.hash);
    return restored;
  }

  function syncFromLocation(hash: string): void {
    const parsed = parseTvHash(hash);
    if (parsed.hash === route().hash) return;
    if (ROOT_HASHES.has(parsed.hash)) {
      setStack([{ hash: parsed.hash, focusedId: null, scrollTop: 0, shelfScrolls: {} }]);
    } else {
      setStack((prev) => [
        ...prev,
        { hash: parsed.hash, focusedId: null, scrollTop: 0, shelfScrolls: {} },
      ]);
    }
    setRoute(parsed);
  }

  const canPopOrReturnHome = () => stack().length > 1 || route().name !== 'home';

  return {
    route,
    stack,
    push,
    replaceRoot,
    pop,
    syncFromLocation,
    canPopOrReturnHome,
  };
}
