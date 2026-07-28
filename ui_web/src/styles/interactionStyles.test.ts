import fs from 'node:fs';
import path from 'node:path';
import postcss, { type AtRule } from 'postcss';
import { describe, expect, it } from 'vitest';

function cssFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return cssFiles(file);
    return entry.name.endsWith('.css') ? [file] : [];
  });
}

describe('input-capability CSS policy', () => {
  it('keeps every hover selector behind a fine pointer media query', () => {
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const violations: string[] = [];

    for (const file of cssFiles(sourceRoot)) {
      const root = postcss.parse(fs.readFileSync(file, 'utf8'), { from: file });
      root.walkRules((rule) => {
        if (!rule.selector.includes(':hover')) return;
        const media: AtRule[] = [];
        let parent = rule.parent;
        while (parent && parent.type !== 'root') {
          if (parent.type === 'atrule' && parent.name === 'media') media.push(parent);
          parent = parent.parent;
        }
        const guarded = media.some(
          (query) =>
            query.params.includes('hover: hover') && query.params.includes('pointer: fine'),
        );
        if (!guarded) {
          violations.push(`${path.relative(sourceRoot, file)}: ${rule.selector}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
