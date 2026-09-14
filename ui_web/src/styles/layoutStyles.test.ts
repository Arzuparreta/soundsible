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
      // The pager pill keeps this margin on both sides — below it to the card's
      // bottom edge, above it to the last row of panel content — whatever the
      // device's home indicator costs.
      '--player-carousel-inset': '20px',
      '--player-carousel-bottom':
        'calc(var(--player-mobile-safe-bottom) + var(--player-carousel-inset))',
      '--player-mobile-footer-clearance':
        'calc(var(--player-carousel-height) + var(--player-carousel-inset) * 2)',
    });
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

  it('gives the note only what is left over, never what the artist still needs', () => {
    const detail = declarations(row, '.detail');
    const annotation = declarations(row, '.annotation');

    // The mechanism is the zero basis, not a shrink factor. Competing shrink
    // factors only slow the theft down — they still take a slice of the name on
    // every overflowing line, which is exactly how the route came to read "N · …".
    expect(annotation.flex).toBe('1 1 0');
    expect(annotation['min-width']).toBe('0');
    expect(detail).toMatchObject({ flex: '0 1 auto', 'min-width': '0' });
    expect(declarations(row, '.subtitle')['min-width']).toBe('0');
  });

  it('lets the artist clip its own text instead of being dropped whole', () => {
    // It is an inline-block, because it carries its own touch target, and an
    // inline-block that does not fit is replaced by the line's ellipsis rather
    // than losing its last letters.
    expect(declarations(row, '.detail a')).toMatchObject({
      'max-width': '100%', overflow: 'hidden', 'text-overflow': 'ellipsis',
    });
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
