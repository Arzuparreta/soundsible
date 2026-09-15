import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { EXTRA_THEMES } from '../boot/themes';
import { declarations, TOKENS_FILE } from './testing/tokens';

/*
 * The accent is a theme's to choose.
 *
 * It was not, until the forest palette wanted amber: four stylesheets painted
 * the signature orange as a literal, so those surfaces stayed orange whatever
 * the palette said — a wrong colour in exactly the places (a focus ring, the
 * active row, the level meter) that exist to be noticed.
 *
 * So the literal belongs to tokens.css and nowhere else, and any palette that
 * moves --accent has to move everything derived from it in the same breath.
 */

const src = process.cwd();
const ORANGE = /#f97a12|#ff8d2e|#d8630a|rgba?\(\s*249\s*,\s*122\s*,\s*18/i;

/** Every stylesheet the player ships, tokens.css aside. */
function stylesheets(dir = path.join(src, 'src')): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return stylesheets(full);
    return entry.isFile() && entry.name.endsWith('.css') && full !== TOKENS_FILE ? [full] : [];
  });
}

/** The accent tokens whose value is the accent itself, rather than a var() of it. */
const DERIVED = [
  '--accent',
  '--accent-hover',
  '--accent-press',
  '--accent-soft',
  '--accent-faint',
  '--accent-glow',
  '--selection-bg',
  '--ambient-accent',
  '--shadow-accent',
];

describe('accent', () => {
  it('is written down once', () => {
    const offenders = stylesheets()
      .filter((file) => ORANGE.test(fs.readFileSync(file, 'utf8')))
      // The boot splash paints before tokens.css exists, so it keeps its own
      // copy — but behind --startup-* tokens a palette can still override.
      .filter((file) => !file.endsWith(path.join('boot', 'startup.css')))
      .map((file) => path.relative(src, file));

    expect(offenders, 'paint the accent with a token, not the literal').toEqual([]);
  });

  it.each(EXTRA_THEMES)('%s carries its accent through every derived token', (theme) => {
    const palette = declarations((selector) => selector === `:root[data-theme='${theme}']`);
    if (!('--accent' in palette)) return; // keeps the signature orange, nothing to check

    const accent = palette['--accent'].toLowerCase();
    expect(ORANGE.test(accent), `${theme} sets --accent but to the signature orange`).toBe(false);
    for (const token of DERIVED) {
      expect(palette, `${theme} moves --accent but leaves ${token} behind`).toHaveProperty(token);
      expect(ORANGE.test(palette[token]), `${theme}'s ${token} is still orange`).toBe(false);
    }
    // Text on an accent fill is picked for that fill; a new accent needs a new one.
    expect(palette, `${theme} moves --accent but not --ink-on-accent`).toHaveProperty('--ink-on-accent');
  });
});
