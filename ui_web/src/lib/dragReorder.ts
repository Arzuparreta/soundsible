/**
 * Where a dragged song would land.
 *
 * Pure geometry, deliberately: the route panel used to expose insertion points
 * as 0.55rem buttons that were invisible until hovered, so placing a song
 * meant hitting a target you could not see. Choosing the *nearest* seam instead
 * of the one under the pointer is what makes a drop feel magnetic — the
 * indicator commits to a slot well before the pointer arrives at it.
 *
 * Rects come in as plain numbers so this can be tested without a DOM.
 */

export interface DragRow {
  /** Occurrence id of the row that begins at this offset. */
  id: string;
  /** Offset of the row's top edge, in the same space as the pointer. */
  top: number;
  height: number;
  /** No drop may be inserted before this row. The cued handoff is already
   * loaded and no longer anybody's to displace, so the seam above it describes
   * a position nothing can take — better never offered than silently refused. */
  fixed?: boolean;
}

export interface DropSlot {
  /** How many rows sit before this seam. */
  index: number;
  /** The row this drop would insert *before*, or undefined at the very end. */
  beforeId?: string;
  /** Where the insertion line is drawn. */
  offset: number;
}

/** Every seam in a list of rows, including the one before the first row and the
 * one after the last. `n` rows produce `n + 1` slots, less any that a `fixed`
 * row rules out. Dropping a seam does not renumber the rest: `index` counts
 * rows, not slots, so the survivors keep the positions they describe. */
export function buildDropSlots(rows: readonly DragRow[]): DropSlot[] {
  const slots: DropSlot[] = [];
  rows.forEach((row, index) => {
    if (row.fixed) return;
    slots.push({ index, beforeId: row.id, offset: row.top });
  });
  const last = rows[rows.length - 1];
  slots.push({
    index: rows.length,
    beforeId: undefined,
    offset: last ? last.top + last.height : 0,
  });
  return slots;
}

/** The seam a pointer is closest to. Distance, not containment — a pointer in
 * the middle of a row still has a nearest edge, and that is the answer. */
export function nearestSlot(slots: readonly DropSlot[], pointerY: number): DropSlot | null {
  let best: DropSlot | null = null;
  let bestDistance = Infinity;
  for (const slot of slots) {
    const distance = Math.abs(slot.offset - pointerY);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = slot;
    }
  }
  return best;
}

/**
 * A drop that would not move anything.
 *
 * Dragging a row onto its own top edge, or onto the edge just below it, both
 * describe the position it already occupies. Reporting those as real moves
 * makes a list flicker and costs a needless re-plan.
 *
 * What is dragged may be several rows travelling as one — a bridge belongs with
 * the song it leads into — so the span between the block's own edges, and every
 * seam inside it, all describe where it already is.
 */
export function isNoopMove(ids: readonly string[], blockIds: readonly string[], slot: DropSlot): boolean {
  const positions = blockIds.map((id) => ids.indexOf(id)).filter((index) => index !== -1);
  if (!positions.length) return false;
  return slot.index >= Math.min(...positions) && slot.index <= Math.max(...positions) + 1;
}

export const EDGE_SCROLL_ZONE = 48;
export const EDGE_SCROLL_MAX = 18;

/**
 * How far to scroll a list whose edge a drag is hovering near, in pixels per
 * frame. Zero anywhere but the top and bottom bands, and it ramps rather than
 * switching on, so a drag that grazes the edge does not bolt.
 */
export function edgeScrollDelta(
  pointerY: number,
  bounds: { top: number; bottom: number },
): number {
  const zone = Math.min(EDGE_SCROLL_ZONE, Math.max(0, (bounds.bottom - bounds.top) / 3));
  if (zone <= 0) return 0;
  if (pointerY < bounds.top + zone) {
    return -Math.round(((bounds.top + zone - pointerY) / zone) * EDGE_SCROLL_MAX);
  }
  if (pointerY > bounds.bottom - zone) {
    return Math.round(((pointerY - (bounds.bottom - zone)) / zone) * EDGE_SCROLL_MAX);
  }
  return 0;
}

/** Read the rows a container is currently showing, in its own coordinate
 * space, from elements marked with `data-drag-row`. */
export function readDragRows(container: HTMLElement): DragRow[] {
  const origin = container.getBoundingClientRect().top - container.scrollTop;
  return [...container.querySelectorAll<HTMLElement>('[data-drag-row]')].map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      id: element.dataset.dragRow ?? '',
      top: rect.top - origin,
      height: rect.height,
      fixed: element.dataset.dragFixed !== undefined,
    };
  });
}

/** Convert a viewport pointer position into the container's coordinate space. */
export function containerPointer(container: HTMLElement, clientY: number): number {
  return clientY - container.getBoundingClientRect().top + container.scrollTop;
}
