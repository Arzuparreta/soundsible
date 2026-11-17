import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlDebt, styleDebt, regressions } from './check-design.mjs';

test('JSX control enforcement ignores comments and strings, and sees native controls', () => {
  assert.equal(controlDebt('const example = "<button>"; /* <input /> */ const view = <><Control /><button /><select /></>'), 2);
});
test('style enforcement distinguishes tokens and hairlines from recipe literals', () => {
  assert.equal(styleDebt('.a { width: var(--control-h); border: 1px solid currentColor; height: 0; }'), 0);
  assert.equal(styleDebt('.a { color: #fff; gap: 8px; width: var(--size, 40px); }'), 3);
});
test('a new file cannot spend debt removed from an old file', () => {
  assert.equal(regressions({ a: { controls: 1 } }, { a: { controls: 2 } }).length, 0);
  assert.equal(regressions({ b: { controls: 1 } }, { a: { controls: 2 } }).length, 1);
});
