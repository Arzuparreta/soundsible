import { describe, expect, it } from 'vitest';
import {
  buildDropSlots,
  edgeScrollDelta,
  isNoopMove,
  nearestSlot,
  readDragRows,
  type DragRow,
} from './dragReorder';

/** jsdom lays nothing out, so every rect this file needs is stated outright. */
function stubRect(element: HTMLElement, top: number, height: number) {
  element.getBoundingClientRect = () =>
    ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
}

const rows: DragRow[] = [
  { id: 'a', top: 0, height: 50 },
  { id: 'b', top: 50, height: 50 },
  { id: 'c', top: 100, height: 50 },
];

describe('dragReorder', () => {
  it('offers one more seam than there are rows, ending after the last', () => {
    const slots = buildDropSlots(rows);
    expect(slots.map((slot) => slot.beforeId)).toEqual(['a', 'b', 'c', undefined]);
    expect(slots.map((slot) => slot.offset)).toEqual([0, 50, 100, 150]);
    expect(slots.at(-1)!.index).toBe(3);
  });

  it('has a seam to aim at even with nothing in the list', () => {
    expect(buildDropSlots([])).toEqual([{ index: 0, beforeId: undefined, offset: 0 }]);
  });

  it('snaps to the nearest seam rather than the row under the pointer', () => {
    const slots = buildDropSlots(rows);
    // Deep inside row "b", but closer to the seam below it than the one above.
    expect(nearestSlot(slots, 88)?.beforeId).toBe('c');
    expect(nearestSlot(slots, 62)?.beforeId).toBe('b');
    // Past the end of the list is still the final seam, not nothing.
    expect(nearestSlot(slots, 900)?.beforeId).toBeUndefined();
    expect(nearestSlot(slots, -900)?.beforeId).toBe('a');
  });

  it('has no seam to offer when there are no slots', () => {
    expect(nearestSlot([], 10)).toBeNull();
  });

  it('treats both edges of a row as the place it already is', () => {
    const slots = buildDropSlots(rows);
    const ids = rows.map((row) => row.id);
    expect(isNoopMove(ids, ['b'], slots[1])).toBe(true);
    expect(isNoopMove(ids, ['b'], slots[2])).toBe(true);
    expect(isNoopMove(ids, ['b'], slots[0])).toBe(false);
    expect(isNoopMove(ids, ['b'], slots[3])).toBe(false);
    expect(isNoopMove(ids, ['missing'], slots[0])).toBe(false);
  });

  it('treats a whole block, and every seam inside it, as where it already is', () => {
    const slots = buildDropSlots(rows);
    const ids = rows.map((row) => row.id);
    // A bridge and the song it leads into travel as one.
    expect(isNoopMove(ids, ['a', 'b'], slots[0])).toBe(true);
    expect(isNoopMove(ids, ['a', 'b'], slots[1])).toBe(true);
    expect(isNoopMove(ids, ['a', 'b'], slots[2])).toBe(true);
    expect(isNoopMove(ids, ['a', 'b'], slots[3])).toBe(false);
    expect(isNoopMove(ids, [], slots[0])).toBe(false);
  });

  it('never offers the seam above a fixed row, and does not renumber the rest', () => {
    // The cued handoff leads the route: nothing may be put in front of it.
    const slots = buildDropSlots([{ ...rows[0], fixed: true }, rows[1], rows[2]]);
    expect(slots.map((slot) => slot.beforeId)).toEqual(['b', 'c', undefined]);
    // "before b" still means one row sits ahead of the seam.
    expect(slots.map((slot) => slot.index)).toEqual([1, 2, 3]);
    expect(nearestSlot(slots, -900)?.beforeId).toBe('b');
  });

  it('scrolls only near an edge, and ramps rather than switching on', () => {
    const bounds = { top: 100, bottom: 500 };
    expect(edgeScrollDelta(300, bounds)).toBe(0);
    expect(edgeScrollDelta(110, bounds)).toBeLessThan(0);
    expect(edgeScrollDelta(490, bounds)).toBeGreaterThan(0);
    // Deeper into the band pulls harder.
    expect(Math.abs(edgeScrollDelta(102, bounds))).toBeGreaterThan(Math.abs(edgeScrollDelta(140, bounds)));
    expect(edgeScrollDelta(495, bounds)).toBeGreaterThan(edgeScrollDelta(465, bounds));
  });

  it('does not scroll a list too short to have edges', () => {
    expect(edgeScrollDelta(10, { top: 10, bottom: 10 })).toBe(0);
  });

  it('reads only the rows on screen, in the container’s own space', () => {
    // Each lane scrolls inside the container, so rows scrolled out of a lane
    // still report rects — above or below the container's own band.
    const container = document.createElement('div');
    stubRect(container, 100, 200);
    const placed: Record<string, HTMLElement> = {};
    for (const [id, top, height] of [
      ['above', 0, 50],
      ['first', 120, 50],
      ['fixed', 170, 50],
      ['last', 250, 50],
      ['below', 320, 50],
    ] as const) {
      const row = document.createElement('div');
      row.dataset.dragRow = id;
      stubRect(row, top, height);
      container.append(row);
      placed[id] = row;
    }
    placed.fixed.dataset.dragFixed = '';

    const read = readDragRows(container);
    expect(read.map((row) => row.id)).toEqual(['first', 'fixed', 'last']);
    // Offsets are relative to the container, and `last` straddles its bottom
    // edge — half on screen is still aimable.
    expect(read.map((row) => row.top)).toEqual([20, 70, 150]);
    expect(read.map((row) => row.fixed)).toEqual([false, true, false]);
    // No seam is offered for a row nobody can see.
    expect(buildDropSlots(read).map((slot) => slot.beforeId)).toEqual(['first', 'last', undefined]);
  });

  it('measures rows against a scrolled container', () => {
    const container = document.createElement('div');
    stubRect(container, 100, 200);
    container.scrollTop = 40;
    const row = document.createElement('div');
    row.dataset.dragRow = 'a';
    stubRect(row, 120, 50);
    container.append(row);
    // 20px below the container's top edge, 40px of which is already scrolled past.
    expect(readDragRows(container)).toEqual([{ id: 'a', top: 60, height: 50, fixed: false }]);
  });
});
