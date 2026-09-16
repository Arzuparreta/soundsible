import { beforeEach, describe, expect, it } from 'vitest';
import { setLocale, t } from './i18n';
import type { SectionCatalog, SettingCapabilities } from './settingsCatalog';
import {
  accessibleSections,
  findSectionById,
  groupSections,
  searchSettings,
  type SettingsEntry,
} from './settingsIndex';

function entry(id: string, title: string, blurb: string, adminOnly = false): SettingsEntry {
  return { id, title: () => t(title), blurb: () => t(blurb), adminOnly };
}

const catalog: Record<string, SectionCatalog> = {
  account: {
    title: 'account.title',
    blurb: 'settings.blurb.account',
    settings: [
      {
        id: 'change-password',
        label: 'account.changePassword',
        group: 'settings.group.profile',
        aliases: ['settings.searchAliases.password'],
      },
      { id: 'sign-out', label: 'account.signOut' },
    ],
  },
  library: {
    title: 'settings.libraryCard',
    blurb: 'settings.blurb.library',
    settings: [
      { id: 'rescan', label: 'settings.rescan', group: 'settings.group.sync' },
      {
        id: 'empty-library',
        label: 'settings.emptyLibrary',
        group: 'settings.group.maintenance',
        requires: 'admin',
      },
    ],
  },
  devices: {
    title: 'settings.devices',
    blurb: 'settings.blurb.devices',
    settings: [{ id: 'shared-links', label: 'settings.openSharedLinks', requires: 'sharedLinks' }],
  },
  downloads: {
    title: 'settings.downloads',
    blurb: 'settings.blurb.downloads',
    terms: ['yt-dlp'],
    settings: [],
  },
};

const sections = [
  entry('account', 'account.title', 'settings.blurb.account'),
  entry('library', 'settings.libraryCard', 'settings.blurb.library'),
  entry('devices', 'settings.devices', 'settings.blurb.devices'),
  entry('downloads', 'settings.downloads', 'settings.blurb.downloads', true),
];

const everything: SettingCapabilities = { admin: true, sharedLinks: true };
const member: SettingCapabilities = { admin: false, sharedLinks: false };

function keys(query: string, capabilities = everything, list = sections): string[] | undefined {
  return searchSettings(list, capabilities, query, catalog)?.map((result) => result.key);
}

beforeEach(async () => {
  await setLocale('es');
});

describe('settings index', () => {
  it('keeps server administration out of member navigation and deep links', () => {
    const memberSections = accessibleSections(sections, false);

    expect(memberSections.map((section) => section.id)).toEqual(['account', 'library', 'devices']);
    expect(findSectionById(memberSections, 'downloads')).toBeUndefined();
    expect(accessibleSections(sections, true)).toEqual(sections);
  });

  it('uses the declared group and section order while dropping inaccessible groups', () => {
    const groups = groupSections(accessibleSections(sections, false), [
      { label: () => 'Preferencias', ids: ['library', 'account'] },
      { label: () => 'Sistema', ids: ['downloads'] },
    ]);

    expect(groups.map((group) => group.label)).toEqual(['Preferencias']);
    expect(groups[0].sections.map((section) => section.id)).toEqual(['library', 'account']);
  });
});

describe('settings search', () => {
  it('distinguishes "not searching" from "nothing matched"', () => {
    expect(searchSettings(sections, everything, '   ', catalog)).toBeNull();
    expect(searchSettings(sections, everything, 'podcasts', catalog)).toEqual([]);
  });

  it('lists a setting from inside a submenu, with where it lives', () => {
    const [first] = searchSettings(sections, everything, 'contrasena', catalog)!;

    expect(first).toMatchObject({
      key: 'account/change-password',
      label: 'Cambiar contraseña',
      path: 'Cuenta › Perfil',
      ranges: [[8, 18]],
    });
    expect(first.section.id).toBe('account');
    expect(first.setting?.id).toBe('change-password');
  });

  it('offers the submenu itself first when its name is the query', () => {
    const results = searchSettings(sections, everything, 'biblioteca', catalog)!;

    // Then a row that names it, then the rows that merely live there.
    expect(results.map((result) => result.key)).toEqual([
      'library',
      'library/empty-library',
      'library/rescan',
    ]);
    expect(results[0].setting).toBeUndefined();
    expect(results[0].path).toBe('Sincronizar, importar, limpiar y borrar canciones');
  });

  it('finds a setting through the words people use for it', () => {
    expect(keys('credenciales')).toEqual(['account/change-password']);
    expect(keys('YT-DLP')).toEqual(['downloads']);
  });

  it('finds a setting by its English name in another language', () => {
    expect(keys('password')).toEqual(['account/change-password']);
    expect(keys('sign out')).toEqual(['account/sign-out']);
  });

  it('narrows by the submenu or group a setting sits in', () => {
    expect(keys('archivos')).toEqual(['library/rescan']);
    expect(keys('sincronizacion escanear')).toEqual(['library/rescan']);
    expect(keys('perfil')).toEqual(['account/change-password']);
  });

  it('never offers a row this account or install would not draw', () => {
    expect(keys('vaciar')).toEqual(['library/empty-library']);
    expect(keys('vaciar', member, accessibleSections(sections, false))).toEqual([]);

    expect(keys('enlaces')).toEqual(['devices/shared-links']);
    expect(keys('enlaces', { admin: true, sharedLinks: false })).toEqual([]);

    expect(keys('yt-dlp', member, accessibleSections(sections, false))).toEqual([]);
  });

  it('does not duplicate the path when the group is the submenu', () => {
    const single: Record<string, SectionCatalog> = {
      library: {
        title: 'settings.libraryCard',
        blurb: 'settings.blurb.library',
        settings: [{ id: 'rescan', label: 'settings.rescan', group: 'settings.libraryCard' }],
      },
    };
    const [result] = searchSettings(sections, everything, 'escanear', single)!;

    expect(result.path).toBe('Biblioteca');
  });
});
