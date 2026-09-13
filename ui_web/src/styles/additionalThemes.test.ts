import fs from 'node:fs';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const css = postcss.parse(fs.readFileSync('src/styles/tokens.css', 'utf8'));
function palette(selectors: string[]) {
  const values: Record<string, string> = {};
  css.walkRules(rule => {
    if (rule.parent?.type === 'root' && selectors.includes(rule.selector)) rule.walkDecls(decl => { values[decl.prop] = decl.value; });
  });
  return values;
}
function luminance(hex: string) {
  const rgb = hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a: string, b: string) {
  const [min, max] = [luminance(a), luminance(b)].sort((a, b) => a - b);
  return (max + 0.05) / (min + 0.05);
}
describe.each(['slate', 'pure-black'])('%s palette', theme => {
  it.each([false, true])('keeps text and essential indicators legible (high contrast: %s)', highContrast => {
    const values = palette([':root', `:root[data-theme='${theme}']`, ...(highContrast ? [":root[data-high-contrast='true']", `:root[data-theme='${theme}'][data-high-contrast='true']`] : [])]);
    for (const surface of ['--bg-base', '--bg-raised', '--bg-elevated', '--bg-inset', '--bg-hover', '--bg-active']) {
      for (const ink of ['--ink-primary', '--ink-secondary', '--ink-tertiary', '--accent-ink', '--info', '--success', '--warning', '--danger']) {
        const color = values[ink].startsWith('var(') ? values[values[ink].slice(4, -1)] : values[ink];
        expect(contrast(color, values[surface]), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(values['--hairline-strong'], values[surface]), `essential edge on ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });
});
