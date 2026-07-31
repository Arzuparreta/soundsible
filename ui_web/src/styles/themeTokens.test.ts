import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

/*
 * The fullscreen player is a photographic stage in both themes: the backdrop is
 * artwork blurred to near black and the chrome is white-alpha glass. It opts out
 * of the light theme with [data-immersive-dark], which only works while every
 * token the light theme re-declares is also re-declared for that scope —
 * otherwise the stage inherits half a light theme (dark ink on a black stage,
 * white cards floating over the cover). These tests hold that pairing.
 */

const tokens = path.resolve(process.cwd(), 'src/styles/tokens.css');
const surface = path.resolve(process.cwd(), 'src/components/PlayerSurface.tsx');

function ruleDeclarations(match: (selector: string) => boolean): Record<string, string> {
  const root = postcss.parse(fs.readFileSync(tokens, 'utf8'), { from: tokens });
  const out: Record<string, string> = {};
  root.walkRules((rule) => {
    if (!match(rule.selector.replace(/\s+/g, ' '))) return;
    rule.walkDecls((decl) => {
      out[decl.prop] = decl.value;
    });
  });
  return out;
}

const immersive = (selector: string) => selector.includes('[data-immersive-dark]');
const highContrast = (selector: string) => selector.includes("[data-high-contrast='true']");

describe('immersive dark scope', () => {
  it('covers every token the light theme overrides', () => {
    const light = ruleDeclarations((selector) => selector === ":root[data-theme='light']");
    const dark = ruleDeclarations((selector) => immersive(selector) && !highContrast(selector));

    expect(Object.keys(light).length).toBeGreaterThan(10);
    expect(Object.keys(light).filter((prop) => !(prop in dark))).toEqual([]);
    expect(dark['color-scheme']).toBe('dark');
    expect(light['color-scheme']).toBe('light');
  });

  it('covers every token the light high-contrast palette overrides', () => {
    const lightContrast = ruleDeclarations(
      (selector) => selector === ":root[data-theme='light'][data-high-contrast='true']",
    );
    const darkContrast = ruleDeclarations((selector) => immersive(selector) && highContrast(selector));

    expect(Object.keys(lightContrast).length).toBeGreaterThan(5);
    expect(Object.keys(lightContrast).filter((prop) => !(prop in darkContrast))).toEqual([]);
  });

  it('is claimed by the player surface itself, so Now Playing and Auto both inherit it', () => {
    expect(fs.readFileSync(surface, 'utf8')).toContain('data-immersive-dark=""');
  });
});
