/*
 * Shared reading and colour maths for the stylesheet tests.
 *
 * Three suites walk the same token file and composite the same colours. Kept
 * apart they drifted — one grew a var() resolver, another an rgba() parser,
 * a third neither — so a token written in a form only one of them understood
 * was silently mis-measured by the others. One implementation, one grammar.
 */

import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';

export const TOKENS_FILE = path.resolve(process.cwd(), 'src/styles/tokens.css');

/**
 * Every declaration of the top-level rules whose selector matches, in document
 * order — later rules win, the way the cascade resolves them on :root.
 *
 * Top-level only: the forced-colors block redeclares the same custom properties
 * as system keywords, which are not colours we can composite.
 */
export function declarations(
  match: (selector: string) => boolean,
  file: string = TOKENS_FILE,
): Record<string, string> {
  const root = postcss.parse(fs.readFileSync(file, 'utf8'), { from: file });
  const out: Record<string, string> = {};
  root.walkRules((rule) => {
    if (rule.parent?.type !== 'root') return;
    if (!match(rule.selector.replace(/\s+/g, ' '))) return;
    rule.walkDecls((decl) => {
      out[decl.prop] = decl.value.trim();
    });
  });
  return out;
}

/** The palette a document in these states resolves to: the listed selectors,
 *  merged in document order. */
export function palette(selectors: string[], file: string = TOKENS_FILE): Record<string, string> {
  return declarations((selector) => selectors.includes(selector), file);
}

/** Follow `var(--a, fallback)` chains to the value a browser would paint. */
export function resolve(values: Record<string, string>, prop: string): string {
  let value = values[prop];
  if (value === undefined) throw new Error(`token not declared: ${prop}`);
  for (let hop = 0; hop < 8; hop++) {
    const reference = /^var\(\s*(--[\w-]+)\s*(?:,([^]*))?\)$/.exec(value);
    if (!reference) return value;
    const [, name, fallback] = reference;
    const next = values[name];
    if (next === undefined) {
      if (fallback === undefined) throw new Error(`token not declared: ${name}`);
      value = fallback.trim();
      continue;
    }
    value = next;
  }
  throw new Error(`var() chain does not resolve: ${prop}`);
}

export type Colour = { rgb: number[]; alpha: number };

/** Parse the colour forms the tokens actually use: #rgb, #rrggbb, rgb(), rgba()
 *  — and `transparent`, which is a colour a theme can hand a surface. */
export function colour(value: string): Colour {
  const text = value.trim();
  if (text === 'transparent') return { rgb: [0, 0, 0], alpha: 0 };

  const hex = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      const channels = [...digits].map((d) => parseInt(d + d, 16));
      return { rgb: channels.slice(0, 3), alpha: channels.length === 4 ? channels[3] / 255 : 1 };
    }
    if (digits.length === 6 || digits.length === 8) {
      const channels = digits.match(/../g)!.map((pair) => parseInt(pair, 16));
      return { rgb: channels.slice(0, 3), alpha: channels.length === 4 ? channels[3] / 255 : 1 };
    }
  }

  const functional = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(text);
  if (functional) {
    const raw = functional[4];
    return {
      rgb: functional.slice(1, 4).map(Number),
      alpha: raw === undefined ? 1 : raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw),
    };
  }

  throw new Error(`not a colour this suite can composite: ${value}`);
}

/** An opaque colour's channels. Throws on anything translucent, which has no
 *  single set of channels until something is laid under it. */
export function rgb(value: string): number[] {
  const parsed = colour(value);
  if (parsed.alpha !== 1) throw new Error(`translucent colour needs a backdrop: ${value}`);
  return parsed.rgb;
}

/** Lay `colour` on `under`, the way the browser composites them. */
export function over(top: Colour | string, under: number[]): number[] {
  const { rgb: channels, alpha } = typeof top === 'string' ? colour(top) : top;
  return under.map((c, index) => channels[index] * alpha + c * (1 - alpha));
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance([r, g, b]: number[]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio. Takes channels, or any opaque colour this suite parses. */
export function contrast(a: number[] | string, b: number[] | string): number {
  const first = luminance(typeof a === 'string' ? rgb(a) : a);
  const second = luminance(typeof b === 'string' ? rgb(b) : b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
