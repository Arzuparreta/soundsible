import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

import { EXTRA_THEMES } from '../boot/themes';
import { colour, contrast, over, palette, resolve, rgb } from './testing/tokens';

/*
 * Selected text has to look selected in every palette.
 *
 * The app paints one site-wide ::selection rule, so whichever token it reads is
 * load-bearing in all four themes at once: the OLED palette, whose job is to
 * drop every glow, nulled the decorative --accent-glow and took the highlight
 * down with it — white ink on black, identical selected and not. Hence the
 * separate --selection-bg, and hence this test, which measures the wash the
 * rule actually names rather than a token name it is assumed to use.
 */

const appFile = path.resolve(process.cwd(), 'src/styles/app.css');
const SURFACES = ['--bg-base', '--bg-raised', '--bg-elevated', '--bg-inset', '--bg-hover', '--bg-active'];

/** The declarations of the one global ::selection rule. */
function selectionRule(): Record<string, string> {
  const root = postcss.parse(fs.readFileSync(appFile, 'utf8'), { from: appFile });
  const rules: Record<string, string>[] = [];
  root.walkRules(rule => {
    if (rule.selector.replace(/\s+/g, ' ') !== '::selection') return;
    const out: Record<string, string> = {};
    rule.walkDecls(decl => { out[decl.prop] = decl.value.trim(); });
    rules.push(out);
  });
  expect(rules, 'one global ::selection rule').toHaveLength(1);
  return rules[0];
}

/** The token a declaration paints with, e.g. `var(--selection-bg)` → the value. */
function painted(values: Record<string, string>, declaration: string): string {
  const token = /^var\(\s*(--[\w-]+)/.exec(declaration);
  expect(token, `::selection paints with a token, not a literal: ${declaration}`).not.toBeNull();
  return resolve(values, token![1]);
}

/* Dark is bare :root; every other palette is an override block, and the extra
   ones come from the shared list so a new theme is measured without an edit. */
describe.each([
  ['dark', [] as string[]],
  ['light', [":root[data-theme='light']"]],
  ...EXTRA_THEMES.map(theme => [theme, [`:root[data-theme='${theme}']`]] as const),
] as const)('%s selection', (theme, themeSelectors) => {
  it.each([false, true])('stays visible over every surface (high contrast: %s)', highContrast => {
    const selectors = [':root', ...themeSelectors];
    if (highContrast) {
      selectors.push(":root[data-high-contrast='true']");
      for (const selector of themeSelectors) selectors.push(`${selector}[data-high-contrast='true']`);
    }
    const values = palette(selectors);
    const rule = selectionRule();
    const wash = colour(painted(values, rule.background));
    const ink = painted(values, rule.color);

    expect(wash.alpha, `${theme} selection wash is a colour`).toBeGreaterThan(0);
    for (const surface of SURFACES) {
      const under = rgb(resolve(values, surface));
      const selected = over(wash, under);
      // 1.15 is the faintest wash the design ships (the light palette's): below
      // it the highlight has stopped being a highlight.
      expect(contrast(selected, under), `${theme} wash on ${surface}`).toBeGreaterThanOrEqual(1.15);
      expect(contrast(ink, selected), `${theme} selected ink on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
