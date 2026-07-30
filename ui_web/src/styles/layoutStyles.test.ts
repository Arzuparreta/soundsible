import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

function declarations(file: string, selector: string): Record<string, string> {
  const root = postcss.parse(fs.readFileSync(file, 'utf8'), { from: file });
  const out: Record<string, string> = {};
  root.walkRules((rule) => {
    if (rule.selector !== selector) return;
    rule.walkDecls((decl) => {
      out[decl.prop] = decl.value;
    });
  });
  return out;
}

describe('route scroll containment', () => {
  it('clips horizontal viewport drift on the shell and every primary scroller', () => {
    const styles = path.resolve(process.cwd(), 'src/styles/app.css');
    const shell = path.resolve(process.cwd(), 'src/app.module.css');

    expect(declarations(styles, '[data-primary-scroll]')).toMatchObject({
      'min-width': '0',
      'max-width': '100%',
      'overflow-x': 'clip',
      'overscroll-behavior-x': 'none',
    });
    expect(declarations(shell, '.content')['overflow-x']).toBe('clip');
  });

  it('contains intentional horizontal rails independently', () => {
    const styles = path.resolve(process.cwd(), 'src/styles/app.css');
    expect(declarations(styles, '[data-horizontal-scroll]')).toMatchObject({
      'max-width': '100%',
      'overflow-x': 'auto',
      'overscroll-behavior-x': 'contain',
    });
  });
});
