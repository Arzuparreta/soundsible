import { expect, test } from 'vitest';
import { placePopover } from './contextMenu';

const viewport = { width: 1366, height: 768 };
const rect = (left: number, top: number, width = 36, height = 36) => new DOMRect(left, top, width, height);

test('a pointer menu opens at the cursor when it fits', () => {
  expect(placePopover({ x: 200, y: 100 }, { width: 224, height: 300 }, viewport)).toEqual({ x: 200, y: 100 });
});

test('a pointer menu is pulled back inside the right and bottom edges', () => {
  // The measured case from the review: 224×641 opened at y 144 ended 17.6px
  // below a 768px window, because the clamp used the box scaled to 0.96.
  expect(placePopover({ x: 1300, y: 144 }, { width: 224, height: 641 }, viewport)).toEqual({ x: 1134, y: 119 });
});

test('a menu taller than the window starts at the top padding', () => {
  expect(placePopover({ x: 10, y: 400 }, { width: 224, height: 900 }, viewport).y).toBe(8);
});

test('a keyboard menu hangs under its control, not at the click coordinates', () => {
  expect(placePopover({ x: 0, y: 0, anchor: rect(600, 200) }, { width: 224, height: 300 }, viewport)).toEqual({ x: 600, y: 240 });
});

test('a keyboard menu opens above its control when there is no room below', () => {
  expect(placePopover({ x: 0, y: 0, anchor: rect(600, 600) }, { width: 224, height: 300 }, viewport)).toEqual({ x: 600, y: 296 });
});
