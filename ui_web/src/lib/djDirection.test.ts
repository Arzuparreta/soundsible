import { describe, expect, it } from 'vitest';
import type { DjDirection } from './api';
import { parseDjDirection } from './djDirection';

const base: DjDirection = { energy: 0, familiarity: 0, prompt: '', include: [], exclude: [] };

describe('parseDjDirection', () => {
  it('maps energy and discovery language onto bounded controls', () => {
    const result = parseDjDirection('Sube la energía y sorpréndeme', base);
    expect(result.energy).toBeGreaterThan(0);
    expect(result.familiarity).toBeLessThan(0);
  });

  it('extracts musical destinations and exclusions', () => {
    const result = parseDjDirection('Tira a disco sin reggaeton', base);
    expect(result.include).toEqual(['disco']);
    expect(result.exclude).toEqual(['reggaeton']);
  });

  it('keeps values bounded across repeated commands', () => {
    let result = base;
    for (let i = 0; i < 10; i += 1) result = parseDjDirection('más energía', result);
    expect(result.energy).toBe(1);
  });
});
