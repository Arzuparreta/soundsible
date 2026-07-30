import { describe, expect, it } from 'vitest';
import type { DjDirection } from './api';
import { parseDjDirection, parseNamedRequest } from './djDirection';

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

describe('parseNamedRequest', () => {
  it('hears an act asked for by name, in any of the four languages', () => {
    expect(parseNamedRequest('pon oliver heldens')).toBe('oliver heldens');
    expect(parseNamedRequest('ponme el parrita')).toBe('el parrita');
    expect(parseNamedRequest('play Fatboy Slim')).toBe('Fatboy Slim');
    expect(parseNamedRequest('mets Daft Punk')).toBe('Daft Punk');
    expect(parseNamedRequest('放 Oliver Heldens')).toBe('Oliver Heldens');
    expect(parseNamedRequest('quiero escuchar rosalía')).toBe('rosalía');
    expect(parseNamedRequest('música de bad bunny')).toBe('bad bunny');
  });

  it('does not mistake a mood for a name', () => {
    // "algo de X" is a flavour, and the direction parser already reads it as a
    // destination. Firing a lookup for it would promise a track nobody named.
    expect(parseNamedRequest('pon algo de funk')).toBeNull();
    expect(parseNamedRequest('pon algo más movido')).toBeNull();
    expect(parseNamedRequest('play something else')).toBeNull();
    expect(parseNamedRequest('más energía')).toBeNull();
    expect(parseNamedRequest('sube la caña')).toBeNull();
    // A mention is not a request.
    expect(parseNamedRequest('esto suena a oliver heldens')).toBeNull();
  });

  it('keeps the name and leaves the steering to the direction parser', () => {
    expect(parseNamedRequest('pon oliver heldens pero más suave')).toBe('oliver heldens');
    expect(parseNamedRequest('pon el parrita, y luego tira a flamenco')).toBe('el parrita');
    // The same phrase still carries its direction.
    expect(parseDjDirection('pon oliver heldens pero más suave', base).energy).toBeLessThan(0);
  });
});
