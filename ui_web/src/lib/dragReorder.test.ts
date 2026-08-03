import { describe, expect, it } from 'vitest';
import {
  buildDropSlots,
  edgeScrollDelta,
  isNoopMove,
  nearestSlot,
  type DragRow,
} from './dragReorder';

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
    expect(isNoopMove(ids, 'b', slots[1])).toBe(true);
    expect(isNoopMove(ids, 'b', slots[2])).toBe(true);
    expect(isNoopMove(ids, 'b', slots[0])).toBe(false);
    expect(isNoopMove(ids, 'b', slots[3])).toBe(false);
    expect(isNoopMove(ids, 'missing', slots[0])).toBe(false);
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
});
