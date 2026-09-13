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
  const workspace = path.resolve(process.cwd(), 'src/components/PlayerWorkspace.module.css');
  const browser = path.resolve(process.cwd(), 'src/components/NowPlayingBrowser.module.css');
  const surface = path.resolve(process.cwd(), 'src/components/PlayerSurface.module.css');
  const tokens = path.resolve(process.cwd(), 'src/styles/tokens.css');

  it('uses the visual viewport and reserves both device safe areas through shared geometry', () => {
    const surfaceGeometry = scopedDeclarations(surface, '.surface');
    expect(surfaceGeometry).toMatchObject({
      height: 'var(--app-viewport-height, 100dvh)',
      '--player-chrome-top': 'max(14px, env(safe-area-inset-top, 0px))',
      '--player-mobile-safe-bottom': 'env(safe-area-inset-bottom, 0px)',
      '--player-carousel-bottom': 'max(10px, var(--player-mobile-safe-bottom))',
    });
    expect(surfaceGeometry['--player-mobile-footer-clearance'].replace(/\s+/g, ' ')).toBe(
      'calc( var(--player-carousel-height) + 8px + max(0px, calc(var(--player-carousel-bottom) - var(--player-mobile-safe-bottom))) )',
    );
    expect(scopedDeclarations(workspace, '.workspace', 'max-width: 1023px')).toMatchObject({
      'padding-top':
        'calc(var(--player-chrome-top) + var(--player-chrome-size) + var(--player-chrome-gap))',
      'padding-bottom': 'var(--player-mobile-safe-bottom)',
    });
  });

  it('never hides a rendered browser tile behind a second CSS visibility contract', () => {
    // The tiles moved to PlayerWorkspace; NowPlaying is still checked because
    // it is the file that grew the duplicate contract this guards against.
    const hiddenRules: string[] = [];
    for (const file of [workspace, nowPlaying]) {
      const root = postcss.parse(fs.readFileSync(file, 'utf8'), { from: file });
      root.walkRules((rule) => {
        if (!/\[data-(player|now-playing)-tile='browser'\]/.test(rule.selector)) return;
        rule.walkDecls('display', (decl) => {
          if (decl.value === 'none') hiddenRules.push(`${path.basename(file)} — ${rule.selector}`);
        });
      });
    }
    expect(hiddenRules).toEqual([]);
  });

  it('keeps desktop layout controls above the workspace and browser close mobile-only', () => {
    expect(scopedDeclarations(surface, '.layoutButton')).toMatchObject({
      display: 'none',
    });
    expect(scopedDeclarations(surface, '.layoutButton', 'min-width: 1024px')).toMatchObject({
      display: 'inline-grid',
    });
    expect(scopedDeclarations(browser, '.close', 'min-width:1024px')).toMatchObject({
      display: 'none',
    });

    const z = declarations(tokens, ':root');
    expect(Number(z['--z-auto'])).toBeLessThan(Number(z['--z-modal']));
    expect(Number(z['--z-modal'])).toBeLessThan(Number(z['--z-popover']));
    expect(Number(z['--z-popover'])).toBeLessThan(Number(z['--z-toast']));
  });
});

/* Two rows in the DJ's route differed only in whether they carried a ⋯, and the
   one without it was the only one whose artist name fitted. The control is back
   on every row; these lock in the other half of the fix — that when the line is
   still too narrow, the note gives way before the name does. */
describe('list row metadata priority', () => {
  const row = path.resolve(process.cwd(), 'src/components/MusicListRow.module.css');
  const omni = path.resolve(process.cwd(), 'src/components/OmniBar.module.css');

  it('lets the annotation yield its width to the artist, not the other way round', () => {
    const detail = declarations(row, '.detail');
    const annotation = declarations(row, '.annotation');

    expect(detail).toMatchObject({ flex: '1 1 auto', 'min-width': '0' });
    // A shrink factor above the detail's 1 is the whole mechanism: the note
    // gives up width faster per pixel of overflow, down to a readable floor.
    const [, shrink] = annotation.flex.split(' ');
    expect(Number(shrink)).toBeGreaterThan(1);
    expect(annotation['min-width']).toBe('4ch');
    expect(annotation['text-overflow']).toBe('ellipsis');
    expect(declarations(row, '.subtitle')['min-width']).toBe('0');
  });

  it('keeps the compact pill open target above its artwork and below a real link', () => {
    const open = Number(declarations(omni, '.openButton')['z-index']);
    const link = Number(declarations(omni, '.meta a')['z-index']);

    // `.cover` is positioned and later in the DOM, so without a layer of its
    // own the open button never received a press aimed at the artwork.
    expect(open).toBeGreaterThan(0);
    expect(link).toBeGreaterThan(open);
  });
});
