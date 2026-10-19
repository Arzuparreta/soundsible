import { describe, expect, it } from 'vitest';
import {
  buildDropSlots,
  dropBeforeId,
  dropIndex,
  dropTarget,
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
    expect(slots.map((slot) => slot.afterId)).toEqual([undefined, 'a', 'b', 'c']);
    expect(slots.map((slot) => slot.offset)).toEqual([0, 50, 100, 150]);
  });

  it('has a seam to aim at even with nothing in the list', () => {
    expect(buildDropSlots([])).toEqual([{ beforeId: undefined, afterId: undefined, offset: 0 }]);
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
    expect(isNoopMove(['b'], slots[1])).toBe(true);
    expect(isNoopMove(['b'], slots[2])).toBe(true);
    expect(isNoopMove(['b'], slots[0])).toBe(false);
    expect(isNoopMove(['b'], slots[3])).toBe(false);
    expect(isNoopMove(['missing'], slots[0])).toBe(false);
  });

  it('treats a whole block, and every seam inside it, as where it already is', () => {
    const slots = buildDropSlots(rows);
    // A bridge and the song it leads into travel as one.
    expect(isNoopMove(['a', 'b'], slots[0])).toBe(true);
    expect(isNoopMove(['a', 'b'], slots[1])).toBe(true);
    expect(isNoopMove(['a', 'b'], slots[2])).toBe(true);
    expect(isNoopMove(['a', 'b'], slots[3])).toBe(false);
    expect(isNoopMove([], slots[0])).toBe(false);
  });

  it('judges a move by the rows beside the seam, however far the lane is scrolled', () => {
    // Only "m" and "n" are on screen, deep inside a longer list.
    const slots = buildDropSlots([{ id: 'm', top: 0, height: 50 }, { id: 'n', top: 50, height: 50 }]);
    expect(isNoopMove(['n'], slots[1])).toBe(true);
    expect(isNoopMove(['m'], slots[2])).toBe(false);
  });

  it('never offers the seam above a fixed row', () => {
    // The cued handoff leads the route: nothing may be put in front of it.
    const slots = buildDropSlots([{ ...rows[0], fixed: true }, rows[1], rows[2]]);
    expect(slots.map((slot) => slot.beforeId)).toEqual(['b', 'c', undefined]);
    // The seam that is left still knows the fixed row sits above it.
    expect(slots[0].afterId).toBe('a');
    expect(nearestSlot(slots, -900)?.beforeId).toBe('b');
  });

  it('lands a drop under the last row on screen right after it, not at the end of the list', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    // A card showing its first three songs, or a lane scrolled to show them.
    const shown = buildDropSlots(rows);
    expect(dropBeforeId(ids, shown[3])).toBe('d');
    expect(dropBeforeId(ids, shown[1])).toBe('b');
    expect(dropBeforeId(['a', 'b', 'c'], shown[3])).toBeUndefined();
    expect(dropBeforeId([], buildDropSlots([])[0])).toBeUndefined();
  });

  it('turns a seam into the index a remove-then-insert move puts the row at', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const slots = buildDropSlots(rows);
    // Down: "a" before "c" ends up second, once it has left its own place.
    expect(dropIndex(ids, 'a', slots[2])).toBe(1);
    // Down, under the last row shown: right after "c", ahead of "d".
    expect(dropIndex(ids, 'a', slots[3])).toBe(2);
    // Up: "e" before "b".
    expect(dropIndex(ids, 'e', slots[1])).toBe(1);
    // Up, under the last row shown: right after "c".
    expect(dropIndex(ids, 'e', slots[3])).toBe(3);
    // To the very end of the list.
    expect(dropIndex(['a', 'b', 'c'], 'a', slots[3])).toBe(2);
    expect(dropIndex(ids, 'missing', slots[1])).toBe(-1);
  });

  it('takes a drop only while it accepts one, and takes the entering as well as the hovering', () => {
    let accepting = false;
    const dropped: DragEvent[] = [];
    const handlers = dropTarget(() => accepting, (event) => dropped.push(event));
    const event = (type: string) => new Event(type, { cancelable: true }) as DragEvent;

    const refused = [event('dragenter'), event('dragover'), event('drop')];
    handlers.onDragEnter(refused[0]); handlers.onDragOver(refused[1]); handlers.onDrop(refused[2]);
    expect(refused.map((e) => e.defaultPrevented)).toEqual([false, false, false]);
    expect(dropped).toHaveLength(0);

    accepting = true;
    const taken = [event('dragenter'), event('dragover'), event('drop')];
    handlers.onDragEnter(taken[0]); handlers.onDragOver(taken[1]); handlers.onDrop(taken[2]);
    expect(taken.map((e) => e.defaultPrevented)).toEqual([true, true, true]);
    expect(dropped).toEqual([taken[2]]);
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

  it('reads only the rows of one lane, and only where that lane is on screen', () => {
    const container = document.createElement('div');
    stubRect(container, 100, 300);
    const lanes = [document.createElement('div'), document.createElement('div')];
    // The first lane scrolls inside the container and shows 100–200 only.
    stubRect(lanes[0], 100, 100);
    stubRect(lanes[1], 220, 180);
    for (const [lane, id, top] of [
      [0, 'hidden', 40], [0, 'one', 110], [0, 'two', 160], [0, 'scrolled-out', 210],
      [1, 'other', 230],
    ] as const) {
      const row = document.createElement('div');
      row.dataset.dragRow = id;
      stubRect(row, top, 50);
      lanes[lane].append(row);
    }
    container.append(...lanes);

    expect(readDragRows(container, lanes[0]).map((row) => row.id)).toEqual(['one', 'two']);
    expect(readDragRows(container).map((row) => row.id)).toEqual(['one', 'two', 'scrolled-out', 'other']);
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
