/**
 * Build and resolve artist routes without losing Unicode characters.
 *
 * Artist names are display values rather than URL-safe IDs, so every path
 * segment must be encoded on navigation and decoded exactly once on arrival.
 */
export function artistPath(name: string): string {
  return `/artist/${encodeURIComponent(name.normalize('NFC'))}`;
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
