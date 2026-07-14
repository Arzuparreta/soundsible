/**
 * Build and resolve artist routes without losing Unicode characters.
 *
 * Artist names are display values rather than URL-safe IDs, so every path
 * segment must be encoded on navigation and decoded exactly once on arrival.
 */
export function artistPath(name: string, opts?: { view?: 'discover' | 'library'; deezerId?: string }): string {
  const params = new URLSearchParams();
  if (opts?.view) params.set('view', opts.view);
  if (opts?.deezerId) params.set('deezer_id', opts.deezerId);
  const qs = params.toString();
  return `/artist/${encodeURIComponent(name.normalize('NFC'))}${qs ? `?${qs}` : ''}`;
}

export function albumPath(name: string, artist: string, opts?: { view?: 'discover' | 'library'; deezerId?: string }): string {
  const params = new URLSearchParams({ artist });
  if (opts?.view) params.set('view', opts.view);
  if (opts?.deezerId) params.set('deezer_id', opts.deezerId);
  return `/album/${encodeURIComponent(name.normalize('NFC'))}?${params.toString()}`;
}

export function parseViewParams(query: Record<string, string | undefined>): { view: 'discover' | 'library'; deezerId?: string } {
  return {
    view: query.view === 'library' ? 'library' : 'discover',
    deezerId: query.deezer_id || undefined,
  };
}

export function decodeArtistName(segment: string | undefined): string {
  if (!segment) return '';
  try {
    return decodeURIComponent(segment).normalize('NFC');
  } catch {
    // A manually-entered malformed percent escape should render as text rather
    // than crashing the entire route.
    return segment.normalize('NFC');
  }
}

/** Canonical comparison key for equivalent Unicode spellings and casing. */
export function artistKey(name: string | null | undefined): string {
  return (name ?? '').trim().normalize('NFKC').toLowerCase();
}
