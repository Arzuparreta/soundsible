import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from './i18n/en';
import { es } from './i18n/es';
import { fr } from './i18n/fr';
import { zh } from './i18n/zh';
import { SETTINGS_CATALOG, type SectionCatalog } from './settingsCatalog';

const DICTIONARIES = { en, es, fr, zh };

const sections: SectionCatalog[] = Object.values(SETTINGS_CATALOG);
const settings = sections.flatMap((section) => section.settings);

function lookup(dict: unknown, key: string): unknown {
  let node = dict;
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object' || !(part in node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

describe('settings catalog', () => {
  it('words every result in every language', () => {
    const keys = new Set<string>();
    for (const section of sections) {
      [section.title, section.blurb, ...(section.aliases ?? [])].forEach((key) => keys.add(key));
      for (const setting of section.settings) {
        [setting.label, setting.group, setting.hint, ...(setting.aliases ?? [])]
          .filter((key): key is string => Boolean(key))
          .forEach((key) => keys.add(key));
      }
    }

    const missing = Object.entries(DICTIONARIES).flatMap(([code, dict]) =>
      [...keys].filter((key) => typeof lookup(dict, key) !== 'string').map((key) => `${code}: ${key}`),
    );
    expect(missing).toEqual([]);
  });

  it('gives every setting an anchor of its own', () => {
    const ids = settings.map((setting) => setting.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  /**
   * The types stop a row from carrying an anchor the catalog does not know.
   * This is the other direction: a catalog entry nothing draws would be a
   * search result that opens a submenu and lands nowhere.
   */
  it('lands every result on a row that is actually drawn', () => {
    const root = path.resolve(process.cwd(), 'src/components');
    const source = fs
      .readdirSync(root)
      .filter((file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx'))
      .map((file) => fs.readFileSync(path.join(root, file), 'utf8'))
      .join('\n');
    const drawn = new Set(
      [...source.matchAll(/\banchor="([\w-]+)"|settingAnchor\('([\w-]+)'\)/g)].map(
        (match) => match[1] ?? match[2],
      ),
    );

    expect(settings.map((setting) => setting.id).filter((id) => !drawn.has(id))).toEqual([]);
  });
});
