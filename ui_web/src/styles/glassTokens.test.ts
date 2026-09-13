import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

/*
 * The mini-player pill is the app's one piece of glass: a fill over a blurred
 * backdrop, floating above the library that scrolls under it.
 *
 * The blur is the part no engine guarantees. Chromium skips the backdrop blur
 * over this composition (other backdrop functions on the same element still
 * paint, so the backdrop is reached — the blur alone is dropped), Gecko
 * declares support and paints none of it, and WebKit, which does it properly,
 * loses it for a beat after the player surface closes because the shell the
 * pill lives in stops rendering while that surface is up. A guard on declared
 * support cannot see any of that.
 *
 * So the contract is the fill, and the fill alone: whatever passes behind the
 * pill must barely change its surface, with no blur applied at all.
 */

const src = process.cwd();
const tokensFile = path.resolve(src, 'src/styles/tokens.css');
const pillFile = path.resolve(src, 'src/components/OmniBar.module.css');

function declarations(selectorMatch: (selector: string) => boolean): Record<string, string> {
  const root = postcss.parse(fs.readFileSync(tokensFile, 'utf8'), { from: tokensFile });
  const out: Record<string, string> = {};
  root.walkRules((rule) => {
    // Top-level only: the forced-colors block redeclares the same custom
    // properties as system keywords, which are not colours we can composite.
    if (rule.parent?.type !== 'root') return;
    if (!selectorMatch(rule.selector.replace(/\s+/g, ' '))) return;
    rule.walkDecls((decl) => {
      out[decl.prop] = decl.value.trim();
    });
  });
  return out;
}

const darkTheme = () => declarations((selector) => selector === ':root');
const lightTheme = () => declarations((selector) => selector === ":root[data-theme='light']");
const highContrast = () => declarations((selector) => selector === ":root[data-high-contrast='true']");

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: number[]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: number[], b: number[]): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function hex(value: string): number[] {
  const match = /#([0-9a-f]{6})/i.exec(value);
  if (!match) throw new Error(`not a hex colour: ${value}`);
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(value: string): { colour: number[]; alpha: number } {
  const match = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)/.exec(value);
  if (!match) throw new Error(`not an rgba colour: ${value}`);
  return {
    colour: match.slice(1, 4).map(Number),
    alpha: match[4] === undefined ? 1 : Number(match[4]),
  };
}

/** Lay `alpha` of `colour` on `under`, the way the browser composites them. */
function over(colour: number[], alpha: number, under: number[]): number[] {
  return under.map((c, index) => colour[index] * alpha + c * (1 - alpha));
}

const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];

/** The pill's surface over the two extremes an unblurred backdrop can hand it. */
function extremes(fill: string) {
  const { colour, alpha } = rgba(fill);
  return { onBlack: over(colour, alpha, BLACK), onWhite: over(colour, alpha, WHITE) };
}

describe('mini-player glass', () => {
  it('barely moves between the darkest and the brightest thing behind it', () => {
    for (const [name, theme] of [['dark', darkTheme()], ['light', lightTheme()]] as const) {
      const { onBlack, onWhite } = extremes(theme['--glass-fill']);
      // The floor, not the setting: the old 0.66 fill sat above 2.5:1, which is
      // how the library's rows ended up legible straight through the title, and
      // anything at or below 0.86 alpha still clears 1.4:1. 1.35 is where a hard
      // edge behind the pill stops reading as an edge.
      expect(contrast(onBlack, onWhite), `${name} theme`).toBeLessThanOrEqual(1.35);
    }
  });

  it('holds its ink against either extreme, unblurred', () => {
    const dark = darkTheme();
    const darkGlass = extremes(dark['--glass-fill']);
    // White ink, so the bright backdrop is the hard case.
    expect(contrast(hex(dark['--ink-primary']), darkGlass.onWhite)).toBeGreaterThanOrEqual(7);
    expect(contrast(hex(dark['--ink-secondary']), darkGlass.onWhite)).toBeGreaterThanOrEqual(4.5);

    const light = lightTheme();
    const lightGlass = extremes(light['--glass-fill']);
    // Dark ink, so the black backdrop is the hard case.
    expect(contrast(hex(light['--ink-primary']), lightGlass.onBlack)).toBeGreaterThanOrEqual(7);
    expect(contrast(hex(light['--ink-secondary']), lightGlass.onBlack)).toBeGreaterThanOrEqual(4.5);
  });

  it('spends high contrast on going further, never less far', () => {
    expect(rgba(highContrast()['--glass-fill']).alpha)
      .toBeGreaterThanOrEqual(rgba(darkTheme()['--glass-fill']).alpha);
  });

  it('still asks for the blur, for the engine that paints it', () => {
    const root = postcss.parse(fs.readFileSync(pillFile, 'utf8'), { from: pillFile });
    const pill: Record<string, string> = {};
    root.walkRules((rule) => {
      if (rule.selector !== '.omni') return;
      const media = rule.parent?.type === 'atrule' ? (rule.parent as postcss.AtRule).params : '';
      if (!media.includes('max-width: 1023px')) return;
      rule.walkDecls((decl) => { pill[decl.prop] = decl.value.trim(); });
    });
    expect(pill['backdrop-filter']).toBe('var(--glass-filter)');
    expect(pill['-webkit-backdrop-filter']).toBe('var(--glass-filter)');
    expect(pill.background).toContain('var(--glass-fill)');
  });

  it('never keys the pill\'s legibility off declared support', () => {
    // Both failing engines answer "yes" to @supports and then skip the paint,
    // so a rule that only fires when support is absent fixes nobody. The fill
    // has to be right in the rule everyone gets.
    const root = postcss.parse(fs.readFileSync(pillFile, 'utf8'), { from: pillFile });
    const guarded: string[] = [];
    root.walkAtRules('supports', (rule) => {
      if (!rule.params.includes('backdrop-filter')) return;
      rule.walkDecls((decl) => {
        if (/^background/.test(decl.prop)) guarded.push(`${rule.params} — ${decl.prop}`);
      });
    });
    expect(guarded).toEqual([]);
  });
});
