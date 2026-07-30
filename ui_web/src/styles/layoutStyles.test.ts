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

function scopedDeclarations(
  file: string,
  selector: string,
  mediaFragment?: string,
): Record<string, string> {
  const root = postcss.parse(fs.readFileSync(file, 'utf8'), { from: file });
  const out: Record<string, string> = {};
  root.walkRules((rule) => {
    if (rule.selector !== selector) return;
    const media: string[] = [];
    let parent = rule.parent;
    while (parent && parent.type !== 'root') {
      if (parent.type === 'atrule' && parent.name === 'media') media.push(parent.params);
      parent = parent.parent;
    }
    if (mediaFragment ? !media.some((query) => query.includes(mediaFragment)) : media.length > 0) return;
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

describe('unified player geometry', () => {
  const nowPlaying = path.resolve(process.cwd(), 'src/components/NowPlaying.module.css');
  const surface = path.resolve(process.cwd(), 'src/components/PlayerSurface.module.css');

  it('uses the visual viewport and reserves the top chrome through shared geometry', () => {
    expect(scopedDeclarations(surface, '.surface')).toMatchObject({
      height: 'var(--app-viewport-height, 100dvh)',
      '--player-chrome-top': 'max(14px, env(safe-area-inset-top, 0px))',
    });
    expect(scopedDeclarations(nowPlaying, '.workspace', 'max-width: 1023px')).toMatchObject({
      'padding-top':
        'calc(var(--player-chrome-top) + var(--player-chrome-size) + var(--player-chrome-gap))',
      'padding-bottom': '0',
    });
  });

  it('never hides a rendered browser tile behind a second CSS visibility contract', () => {
    const root = postcss.parse(fs.readFileSync(nowPlaying, 'utf8'), { from: nowPlaying });
    const hiddenRules: string[] = [];
    root.walkRules((rule) => {
      if (!rule.selector.includes("[data-now-playing-tile='browser']")) return;
      rule.walkDecls('display', (decl) => {
        if (decl.value === 'none') hiddenRules.push(rule.selector);
      });
    });
    expect(hiddenRules).toEqual([]);
  });
});
