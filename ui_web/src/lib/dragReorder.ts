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
  /** The row on screen this drop would insert *before*; undefined below the
   * last row on screen. */
  beforeId?: string;
  /** The row on screen this drop would follow; undefined above the first. */
  afterId?: string;
  /** Where the insertion line is drawn. */
  offset: number;
}

/** Every seam in a list of rows, including the one before the first row and the
 * one after the last. `n` rows produce `n + 1` slots, less any that a `fixed`
 * row rules out. */
export function buildDropSlots(rows: readonly DragRow[]): DropSlot[] {
  const slots: DropSlot[] = [];
  rows.forEach((row, index) => {
    if (row.fixed) return;
    slots.push({ beforeId: row.id, afterId: rows[index - 1]?.id, offset: row.top });
  });
  const last = rows[rows.length - 1];
  slots.push({
    beforeId: undefined,
    afterId: last?.id,
    offset: last ? last.top + last.height : 0,
  });
  return slots;
}

/**
 * The row a drop on this seam lands in front of, out of the whole ordered list
 * `ids`, or undefined at its very end.
 *
 * The seam below the last row on screen is not the end of the list: a lane
 * scrolled part-way, or a card showing one page of its songs, has rows below
 * it that are not drawn. The drop goes right after the row the line is drawn
 * under, which is in front of whatever follows that row.
 */
export function dropBeforeId(ids: readonly string[], slot: DropSlot): string | undefined {
  if (slot.beforeId || !slot.afterId) return slot.beforeId;
  const at = ids.indexOf(slot.afterId);
  return at === -1 ? undefined : ids[at + 1];
}

/**
 * Where a row taken out of `ids` must be put back so it lands on this seam: the
 * `to` of a remove-then-insert move. -1 when `id` is not in `ids`.
 */
export function dropIndex(ids: readonly string[], id: string, slot: DropSlot): number {
  const from = ids.indexOf(id);
  if (from === -1) return -1;
  const before = dropBeforeId(ids, slot);
  const target = before === undefined ? ids.length : ids.indexOf(before);
  if (target === -1) return -1;
  return from < target ? target - 1 : target;
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
 * seam inside it, all describe where it already is: each of those seams has a
 * row of the block on one side of it.
 */
export function isNoopMove(blockIds: readonly string[], slot: DropSlot): boolean {
  return blockIds.some((id) => id === slot.beforeId || id === slot.afterId);
}

/**
 * Handlers that make an element take drops while `accepts` says so.
 *
 * `dragenter` is cancelled as well as `dragover`, as the HTML drag-and-drop
 * model asks of a drop target. With `dragover` alone Chromium showed the drop
 * as allowed, yet releasing the mouse just after it crossed into another
 * element — the edge of a row, a button inside it — ended the drag with no
 * `drop` event at all. Aiming between two rows is exactly that.
 */
export function dropTarget(accepts: (event: DragEvent) => boolean, onDrop: (event: DragEvent) => void) {
  const take = (event: DragEvent) => {
    if (accepts(event)) event.preventDefault();
  };
  return {
    onDragEnter: take,
    onDragOver: take,
    onDrop: (event: DragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      onDrop(event);
    },
  };
}

export const EDGE_SCROLL_ZONE = 48;
export const EDGE_SCROLL_MAX = 18;

/**
 * How far to scroll a list whose edge a drag is hovering near, in pixels per
 * frame. Zero anywhere but the top and bottom bands, and it ramps rather than
 * switching on, so a drag that grazes the edge does not bolt. Past the edge —
 * a row dragged out over another lane keeps scrolling its own — it holds at
 * the band's full speed.
 */
export function edgeScrollDelta(
  pointerY: number,
  bounds: { top: number; bottom: number },
): number {
  const zone = Math.min(EDGE_SCROLL_ZONE, Math.max(0, (bounds.bottom - bounds.top) / 3));
  if (zone <= 0) return 0;
  const pull = (depth: number) => Math.round(Math.min(1, depth / zone) * EDGE_SCROLL_MAX);
  if (pointerY < bounds.top + zone) return -pull(bounds.top + zone - pointerY);
  if (pointerY > bounds.bottom - zone) return pull(pointerY - (bounds.bottom - zone));
  return 0;
}

/** Read the rows a container is currently showing, in its own coordinate
 * space, from elements marked with `data-drag-row` — all of them, or only
 * those inside `scope`, such as the one lane a row may move within.
 *
 * Only the rows actually on screen: each lane scrolls inside the container, so
 * a row scrolled out of its lane still reports a real rect somewhere above or
 * below the lane. Left in, those rows offer seams nobody can see, and
 * `nearestSlot` would happily commit the drop to one of them. */
export function readDragRows(container: HTMLElement, scope: HTMLElement = container): DragRow[] {
  const bounds = container.getBoundingClientRect();
  const lane = scope.getBoundingClientRect();
  const top = Math.max(bounds.top, lane.top);
  const bottom = Math.min(bounds.bottom, lane.bottom);
  const origin = bounds.top - container.scrollTop;
  const rows: DragRow[] = [];
  for (const element of scope.querySelectorAll<HTMLElement>('[data-drag-row]')) {
    const rect = element.getBoundingClientRect();
    if (rect.bottom <= top || rect.top >= bottom) continue;
    rows.push({
      id: element.dataset.dragRow ?? '',
      top: rect.top - origin,
      height: rect.height,
      fixed: element.dataset.dragFixed !== undefined,
    });
  }
  return rows;
}

/** Convert a viewport pointer position into the container's coordinate space. */
export function containerPointer(container: HTMLElement, clientY: number): number {
  return clientY - container.getBoundingClientRect().top + container.scrollTop;
}
