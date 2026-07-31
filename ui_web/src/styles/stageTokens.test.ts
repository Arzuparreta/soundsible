import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

/*
 * The player stage is one room rendered in two materials. Dark glass is white
 * alpha over a darkened cover; light glass is white at high alpha over a cover
 * that has been brightened and veiled. Three things have to hold for that to
 * stay true, and none of them are visible in a diff:
 *
 *   1. every --stage-* token exists in both materials,
 *   2. no module inside the player writes a raw neutral colour (that is how the
 *      light theme ended up as dark ink on a black stage),
 *   3. the light material actually clears WCAG against the *worst* wallpaper —
 *      a pitch-black cover, which brightness() cannot lift.
 */

const src = process.cwd();
const tokensFile = path.resolve(src, 'src/styles/tokens.css');
const playerFiles = [
  'src/components/PlayerSurface.module.css',
  'src/components/NowPlaying.module.css',
  'src/components/NowPlayingBrowser.module.css',
  'src/components/AutoMode.module.css',
  'src/components/LyricsPanel.module.css',
].map((file) => path.resolve(src, file));

function declarations(selectorMatch: (selector: string) => boolean): Record<string, string> {
  const root = postcss.parse(fs.readFileSync(tokensFile, 'utf8'), { from: tokensFile });
  const out: Record<string, string> = {};
  root.walkRules((rule) => {
    if (!selectorMatch(rule.selector.replace(/\s+/g, ' '))) return;
    rule.walkDecls((decl) => {
      out[decl.prop] = decl.value.trim();
    });
  });
  return out;
}

const stageDark = () => declarations((selector) => selector === '[data-player-stage]');
const stageLight = () =>
  declarations((selector) => selector === ":root[data-theme='light'] [data-player-stage]");
const lightTheme = () => declarations((selector) => selector === ":root[data-theme='light']");

/* Painted on the photograph or on an orange fill rather than on glass, so both
   materials share one value. */
const SHARED_STAGE_TOKENS = new Set([
  '--stage-on-art-ink',
  '--stage-on-art-ink-soft',
  '--stage-on-art-shadow',
  '--stage-on-art-scrim',
  '--stage-gloss',
]);

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: number[]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(ink: number[], surface: number[]): number {
  const a = luminance(ink);
  const b = luminance(surface);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function hex(value: string): number[] {
  const match = /#([0-9a-f]{6})/i.exec(value);
  if (!match) throw new Error(`not a hex colour: ${value}`);
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Lay `alpha` of `over` on `under`, the way the browser composites them. */
function over(overColor: number[], alpha: number, under: number[]): number[] {
  return under.map((c, i) => overColor[i] * alpha + c * (1 - alpha));
}

describe('player stage tokens', () => {
  it('declares both materials for every token', () => {
    const dark = stageDark();
    const light = stageLight();

    expect(Object.keys(dark).length).toBeGreaterThan(20);
    const missing = Object.keys(dark).filter(
      (token) => !SHARED_STAGE_TOKENS.has(token) && !(token in light),
    );
    expect(missing).toEqual([]);
    // and nothing light-only, which would be a token the dark room never got
    expect(Object.keys(light).filter((token) => !(token in dark))).toEqual([]);
  });

  it('keeps raw neutral colour out of every surface inside the player', () => {
    const violations: string[] = [];
    for (const file of playerFiles) {
      const root = postcss.parse(fs.readFileSync(file, 'utf8'), { from: file });
      root.walkDecls((decl) => {
        // Masks and the grain plate are shapes, not colour.
        if (decl.prop.includes('mask')) return;
        if (decl.value.includes('data:image/svg+xml')) return;
        const neutralAlpha = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g;
        for (const match of decl.value.matchAll(neutralAlpha)) {
          const [r, g, b] = match.slice(1).map(Number);
          if (r === g && g === b) {
            violations.push(`${path.basename(file)} — ${decl.prop}: ${decl.value}`);
          }
        }
        if (/#[0-9a-f]{3,8}\b/i.test(decl.value)) {
          violations.push(`${path.basename(file)} — ${decl.prop}: ${decl.value}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it('clears WCAG on the worst wallpaper the light room can be handed', () => {
    const light = { ...lightTheme(), ...stageLight() };
    const black = [0, 0, 0]; // a pitch-black cover: brightness() cannot lift it
    const white = [255, 255, 255];

    const base = hex(light['--stage-base']);
    const backdropOpacity = Number(light['--stage-backdrop-opacity']);
    const veil = Number(light['--stage-veil-floor']);
    const materialAlpha = Number(/,\s*([\d.]+)\s*\)/.exec(light['--stage-material'])![1]);

    // wallpaper → veil → glass, exactly the order the browser paints them.
    const wallpaper = over(black, backdropOpacity, base);
    const wash = over(white, veil, wallpaper);
    const glass = over(white, materialAlpha, wash);

    const inks = {
      primary: hex(light['--ink-primary']),
      secondary: hex(light['--ink-secondary']),
      tertiary: hex(light['--ink-tertiary']),
      accent: hex(light['--accent-ink']),
    };

    // Body text and the accent as ink: AA on bare stage and on glass.
    expect(contrast(inks.primary, wash)).toBeGreaterThanOrEqual(7);
    expect(contrast(inks.secondary, wash)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(inks.accent, wash)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(inks.primary, glass)).toBeGreaterThanOrEqual(7);
    expect(contrast(inks.secondary, glass)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(inks.accent, glass)).toBeGreaterThanOrEqual(4.5);
    // Tertiary carries uppercase micro-labels: the 3:1 non-text floor.
    expect(contrast(inks.tertiary, wash)).toBeGreaterThanOrEqual(3);
    expect(contrast(inks.tertiary, glass)).toBeGreaterThanOrEqual(3);
  });

  it('is claimed by the surface, so Now Playing and Auto inherit one room', () => {
    const surface = fs.readFileSync(path.resolve(src, 'src/components/PlayerSurface.tsx'), 'utf8');
    expect(surface).toContain('data-player-stage=""');
  });
});
