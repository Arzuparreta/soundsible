import { describe, expect, it } from 'vitest';
import {
  accessibleSections,
  findSectionById,
  groupSections,
  matchSections,
  type SettingsEntry,
} from './settingsIndex';

function entry(
  id: string,
  title: string,
  blurb: string,
  keywords: string[],
  adminOnly = false,
): SettingsEntry {
  return {
    id,
    title: () => title,
    blurb: () => blurb,
    keywords: () => keywords,
    adminOnly,
  };
}

const sections = [
  entry('account', 'Tu cuenta', 'Nombre y contraseña', ['Usuario', 'Cerrar sesión']),
  entry('playback', 'Reproducción', 'Cola y recomendaciones', ['Autoplay']),
  entry('downloads', 'Descargas', 'Calidad de audio', ['yt-dlp'], true),
];

describe('settings index', () => {
  it('keeps server administration out of member navigation and deep links', () => {
    const memberSections = accessibleSections(sections, false);

    expect(memberSections.map((section) => section.id)).toEqual(['account', 'playback']);
    expect(findSectionById(memberSections, 'downloads')).toBeUndefined();
    expect(accessibleSections(sections, true)).toEqual(sections);
  });

  it('matches titles, blurbs and labels using the library search normalization', () => {
    expect(matchSections(sections, 'reproduccion')?.map((section) => section.id)).toEqual([
      'playback',
    ]);
    expect(matchSections(sections, 'CONTRASENA')?.map((section) => section.id)).toEqual([
      'account',
    ]);
    expect(matchSections(sections, 'YT-DLP')?.map((section) => section.id)).toEqual([
      'downloads',
    ]);
    expect(matchSections(sections, '   ')).toBeNull();
    expect(matchSections(sections, 'podcasts')).toEqual([]);
  });

  it('uses the declared group and section order while dropping inaccessible groups', () => {
    const groups = groupSections(accessibleSections(sections, false), [
      { label: () => 'Preferencias', ids: ['playback', 'account'] },
      { label: () => 'Sistema', ids: ['downloads'] },
    ]);

    expect(groups.map((group) => group.label)).toEqual(['Preferencias']);
    expect(groups[0].sections.map((section) => section.id)).toEqual(['playback', 'account']);
  });
});
