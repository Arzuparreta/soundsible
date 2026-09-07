import fs from 'node:fs';
import path from 'node:path';
import postcss, { type AtRule, type Node } from 'postcss';
import { describe, expect, it } from 'vitest';

function cssFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return cssFiles(file);
    return entry.name.endsWith('.css') ? [file] : [];
  });
}

/** Every `@media` a node sits inside, innermost first. */
function mediaAncestors(node: Node): AtRule[] {
  const media: AtRule[] = [];
  let parent = node.parent;
  while (parent) {
    if (parent instanceof postcss.AtRule && parent.name === 'media') media.push(parent);
    parent = parent.parent;
  }
  return media;
}

function guardedByFinePointer(node: Node): boolean {
  return mediaAncestors(node).some(
    (query) => query.params.includes('hover: hover') && query.params.includes('pointer: fine'),
  );
}

describe('input-capability CSS policy', () => {
  it('keeps every hover selector behind a fine pointer media query', () => {
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const violations: string[] = [];

    for (const file of cssFiles(sourceRoot)) {
      const root = postcss.parse(fs.readFileSync(file, 'utf8'), { from: file });
      root.walkRules((rule) => {
        if (!rule.selector.includes(':hover')) return;
        if (!guardedByFinePointer(rule)) {
          violations.push(`${path.relative(sourceRoot, file)}: ${rule.selector}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it('keeps component-specific active paint behind a fine pointer query', () => {
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const paintedProperties = new Set([
      'background',
      'background-color',
      'border-color',
      'box-shadow',
      'color',
      'filter',
    ]);
    const violations: string[] = [];

    for (const file of cssFiles(sourceRoot)) {
      const root = postcss.parse(fs.readFileSync(file, 'utf8'), { from: file });
      root.walkRules((rule) => {
        if (!rule.selector.includes(':active')) return;
        const paints = rule.nodes.some(
          (node) => node.type === 'decl' && paintedProperties.has(node.prop),
        );
        if (!paints) return;

        if (!guardedByFinePointer(rule)) {
          violations.push(`${path.relative(sourceRoot, file)}: ${rule.selector}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });

  /**
   * Text stays copyable.
   *
   * A song title, an error code, a device id — people copy those, and an app
   * that blocks selection outright takes that away. Only two rules may switch
   * it off: the hold guard, which lasts exactly as long as a press-and-hold the
   * app has claimed (lib/holdGesture), and the coarse-pointer rule that keeps
   * touch chrome from selecting itself. A component that reaches for
   * `user-select: none` on its own is how the whole app quietly became
   * unselectable the last time.
   */
  it('blocks selection only for a claimed gesture or a coarse pointer', () => {
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const violations: string[] = [];

    for (const file of cssFiles(sourceRoot)) {
      const root = postcss.parse(fs.readFileSync(file, 'utf8'), { from: file });
      root.walkDecls(/^(-webkit-)?user-select$/, (decl) => {
        if (decl.value.trim() !== 'none') return;
        const rule = decl.parent;
        const selector = rule && rule.type === 'rule' ? rule.selector : '';
        if (selector.includes('[data-hold-gesture]')) return;
        if (mediaAncestors(decl).some((query) => query.params.includes('pointer: coarse'))) return;
        violations.push(`${path.relative(sourceRoot, file)}: ${selector} { ${decl.prop} }`);
      });
    }

    expect(violations).toEqual([]);
  });
});
