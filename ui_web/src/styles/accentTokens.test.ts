import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { TOKENS_FILE } from './testing/tokens';

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

});
