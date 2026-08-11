/**
 * Build and resolve artist routes without losing Unicode characters.
 *
 * Artist names are display values rather than URL-safe IDs, so every path
 * segment must be encoded on navigation and decoded exactly once on arrival.
 */
/**
 * `catalogId` is the engine's id for this artist or record, carried when the
 * link was built from the catalog. It is what lets the page ask the engine
 * which songs these are instead of matching names, so two records sharing a
 * title stay two records. Links from a song row or a Deezer result have no such
 * id, and the pages fall back to matching by name — see `Artist.tsx`.
 */
export function artistPath(
  name: string,
  opts?: { view?: 'discover' | 'library'; deezerId?: string; artistId?: string },
): string {
  const params = new URLSearchParams();
  if (opts?.view) params.set('view', opts.view);
  if (opts?.deezerId) params.set('deezer_id', opts.deezerId);
  if (opts?.artistId) params.set('artist_id', opts.artistId);
  const qs = params.toString();
  return `/artist/${encodeURIComponent(name.normalize('NFC'))}${qs ? `?${qs}` : ''}`;
}

export function albumPath(
  name: string,
  artist: string,
  opts?: { view?: 'discover' | 'library'; deezerId?: string; albumId?: string },
): string {
  const params = new URLSearchParams({ artist });
  if (opts?.view) params.set('view', opts.view);
  if (opts?.deezerId) params.set('deezer_id', opts.deezerId);
  if (opts?.albumId) params.set('album_id', opts.albumId);
  return `/album/${encodeURIComponent(name.normalize('NFC'))}?${params.toString()}`;
}

export function parseViewParams(query: Record<string, string | undefined>): {
  view: 'discover' | 'library';
  deezerId?: string;
  albumId?: string;
  artistId?: string;
} {
  return {
    view: query.view === 'library' ? 'library' : 'discover',
    deezerId: query.deezer_id || undefined,
    // Kept apart rather than folded into one "catalog id": an album id and an
    // artist id are both opaque uuids, and a page that accepted either would
    // happily fetch the wrong entity from a hand-edited URL.
    albumId: query.album_id || undefined,
    artistId: query.artist_id || undefined,
  };
}

/**
 * Decide which tab an artist/album page shows.
 *
 * The URL carries the requested tab and a tap on the toggle overrides it until
 * the next navigation. The clamp is the important part: the toggle is only
 * rendered when the subject is in the library, so a `library` tab that survives
 * onto a subject the user does not own would strand them on an empty list with
 * no control to leave it.
 */
export function resolveViewMode(opts: {
  urlView: 'discover' | 'library';
  override: 'discover' | 'library' | null;
  canToggle: boolean;
}): 'discover' | 'library' {
  if (!opts.canToggle) return 'discover';
  return opts.override ?? opts.urlView;
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
