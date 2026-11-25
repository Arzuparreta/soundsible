import { expect, it } from 'vitest';
import { contrast, deriveCustomColors, parseCustomColors } from '../boot/customColors.js';
import { colour, over, contrast as compositeContrast } from './testing/tokens';

it('accepts compact and full sRGB hex and refuses non-color values', () => {
  expect(parseCustomColors({ canvas: ' FF0 ', accent: '#12aB34' })).toEqual({ canvas: '#ffff00', accent: '#12ab34' });
  for (const accent of [null, 'orange', '#88ff00cc', '#xxa']) {
    expect(parseCustomColors({ canvas: '#fff', accent })).toBeNull();
  }
});

it('keeps foregrounds, fills and focus legible across canvas and accent extremes', () => {
  const seeds = ['#000000', '#ffffff', '#757575', '#777777', '#fe0000', '#00fe01', '#0000fe', '#ffff00', '#00ffff', '#ff00ff', '#f93001', '#112f29', '#7965a8'];
  const ink = ['ink-primary', 'ink-secondary', 'ink-tertiary', 'accent-ink', 'accent-ink-hover', 'info', 'success', 'warning', 'danger'] as const;
  for (const canvas of seeds) {
    for (const accent of seeds) {
      const { tokens } = deriveCustomColors({ canvas, accent });
      // Include maximal dark and light artwork behind the glass, plus selected
      // text, focus on interactive surfaces, and filled buttons in every state.
      const surfaces = [tokens['bg-base'], tokens['bg-inset'], tokens['bg-elevated'], tokens['bg-active'], tokens['selection-bg'],
        ...[[0, 0, 0], [255, 255, 255]].flatMap(artwork => {
          const glass = over({ ...colour(tokens['bg-base']), alpha: 0.84 }, artwork);
          const glossy = over({ ...colour(tokens['ink-primary']), alpha: 0.04 }, glass);
          return [glass, over({ ...colour(tokens.accent), alpha: 0.10 }, glossy)];
        })];
      for (const surface of surfaces) {
        for (const name of ink) {
          expect(compositeContrast(tokens[name], surface), `${canvas} / ${accent}: ${name} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
        expect(compositeContrast(tokens['hairline-strong'], surface)).toBeGreaterThanOrEqual(3);
        for (const fill of [tokens.accent, tokens['accent-hover'], tokens['accent-press']]) {
          expect(compositeContrast(fill, surface)).toBeGreaterThanOrEqual(3);
          expect(contrast(tokens['ink-on-accent'], fill)).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(tokens['ink-on-danger'], tokens.danger)).toBeGreaterThanOrEqual(4.5);
    }
  }
});
