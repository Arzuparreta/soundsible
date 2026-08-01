/**
 * Turns a catalog search response into the page layout, in the server's order.
 *
 * The Search route used to re-group a rank-ordered list into a fixed
 * songs -> artists -> albums order with no cap on the songs, so searching an
 * artist showed thirty of their tracks before the artist themselves. The Now
 * Playing panel did the same thing in the opposite order. Neither could tell
 * you which result actually answered the query.
 *
 * The server now decides both — which row leads and what order the sections go
 * in — and every surface reads that decision from here. What is deliberately
 * *not* shared is the rendering: the route draws grids of cards, the panel draws
 * a list of rows. Share the order, not the pixels.
 */

import type { CatalogItem, CatalogSection } from '../types/music';

export type SectionLayout = 'hero' | 'rows' | 'grid' | 'grid_round';

/**
 * One `searchCache` namespace for every catalog search, shared by the Search
 * route and the Now Playing panel.
 *
 * It used to be one namespace per tab, and the panel cached nothing at all — so
 * the same query could be fetched four times over.
 */
export const CATALOG_CACHE_NS = 'catalog:all';

export interface CachedCatalog {
  items: CatalogItem[];
  sections: CatalogSection[];
  interpretedAs: string;
}

export interface ResolvedSection {
  id: string;
  layout: SectionLayout;
  items: CatalogItem[];
  /** Pre-cap count, so "see all 61" needs no second request. */
  total: number;
}

/** The order the server falls back to, and the one older responses implied. */
const FALLBACK_SPECS: Array<{ id: string; layout: SectionLayout; types: string[] }> = [
  { id: 'songs', layout: 'rows', types: ['track', 'library_track'] },
  { id: 'artists', layout: 'grid_round', types: ['artist'] },
  { id: 'albums', layout: 'grid', types: ['album'] },
  { id: 'playlists', layout: 'grid', types: ['playlist'] },
];

const LAYOUTS: SectionLayout[] = ['hero', 'rows', 'grid', 'grid_round'];

function layoutOf(section: CatalogSection): SectionLayout {
  const declared = section.layout as SectionLayout | undefined;
  if (declared && LAYOUTS.includes(declared)) return declared;
  return FALLBACK_SPECS.find((spec) => spec.id === section.id)?.layout ?? 'rows';
}

/**
 * Resolve section id lists against the items array.
 *
 * Falls back to the old hardcoded grouping when a response carries no sections
 * — an older server, or a cached body from before this contract existed. The
 * page still renders; it just loses the ordering intelligence.
 */
export function resolveSections(
  items: CatalogItem[],
  sections?: CatalogSection[] | null,
): ResolvedSection[] {
  if (!sections?.length) return fallbackSections(items);
  const byId = new Map(items.map((item) => [item.id, item] as const));
  const resolved: ResolvedSection[] = [];
  for (const section of sections) {
    // An id the payload no longer carries is dropped rather than rendered as a
    // hole: sections and items can disagree across a cache boundary.
    const members = (section.item_ids ?? [])
      .map((id) => byId.get(id))
      .filter((item): item is CatalogItem => !!item);
    if (members.length) {
      resolved.push({
        id: section.id,
        layout: layoutOf(section),
        items: members,
        total: section.total ?? members.length,
      });
    }
  }
  return resolved.length ? resolved : fallbackSections(items);
}

function fallbackSections(items: CatalogItem[]): ResolvedSection[] {
  return FALLBACK_SPECS.map((spec) => {
    const members = items.filter((item) => spec.types.includes(item.type));
    return { id: spec.id, layout: spec.layout, items: members, total: members.length };
  }).filter((section) => section.items.length > 0);
}

/** The row the server is confident enough to lead with, if any. */
export function topResultItem(
  sections: ResolvedSection[],
): CatalogItem | null {
  return sections.find((section) => section.id === 'top')?.items[0] ?? null;
}

/** Sections minus the hero, which its own surface renders separately. */
export function bodySections(sections: ResolvedSection[]): ResolvedSection[] {
  return sections.filter((section) => section.id !== 'top');
}

/**
 * The rows a type-filtered tab shows.
 *
 * Tabs filter the one `type=all` response instead of asking for their own.
 * Switching tabs used to fire a whole new provider fan-out for a strictly
 * smaller answer, and the two rankings could disagree.
 */
export function itemsForTypes(items: CatalogItem[], types: string[]): CatalogItem[] {
  return items.filter((item) => types.includes(item.type));
}
