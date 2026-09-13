import { describe, expect, it } from 'vitest';

import { contrast, palette, resolve } from './testing/tokens';

const SURFACES = ['--bg-base', '--bg-raised', '--bg-elevated', '--bg-inset', '--bg-hover', '--bg-active'];
const INKS = ['--ink-primary', '--ink-secondary', '--ink-tertiary', '--accent-ink', '--info', '--success', '--warning', '--danger'];

describe.each(['slate', 'pure-black'])('%s palette', theme => {
  it.each([false, true])('keeps text and essential indicators legible (high contrast: %s)', highContrast => {
    const values = palette([':root', `:root[data-theme='${theme}']`, ...(highContrast ? [":root[data-high-contrast='true']", `:root[data-theme='${theme}'][data-high-contrast='true']`] : [])]);
    for (const surface of SURFACES) {
      for (const ink of INKS) {
        expect(contrast(resolve(values, ink), resolve(values, surface)), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(resolve(values, '--hairline-strong'), resolve(values, surface)), `essential edge on ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });
});
