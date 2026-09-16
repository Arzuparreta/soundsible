import { locale, t, tEn } from './i18n';
import {
  SETTINGS_CATALOG,
  sectionCatalog,
  type SectionCatalog,
  type SettingCapabilities,
  type SettingDescriptor,
} from './settingsCatalog';
import { rankDocs, type MatchRange, type SearchDoc, type SearchField } from './settingsSearch';

/**
 * The rules that turn the settings registry into an index: who may open what,
 * how the submenus are grouped, and what a search finds. Pure on purpose —
 * the registry itself drags in the whole app, this does not.
 */
export interface SettingsEntry {
  id: string;
  title: () => string;
  blurb: () => string;
  /** Admin-only entries act on the shared server, not on this account. */
  adminOnly?: boolean;
}

export interface SettingsGroupSpec {
  label: () => string;
  ids: string[];
}

export function accessibleSections<T extends SettingsEntry>(sections: T[], admin: boolean): T[] {
  return sections.filter((section) => !section.adminOnly || admin);
}

export function findSectionById<T extends SettingsEntry>(
  sections: T[],
  id: string | undefined,
): T | undefined {
  if (!id) return undefined;
  return sections.find((section) => section.id === id);
}

/** One row of search results: a whole submenu, or one setting inside it. */
export interface SettingsSearchResult<T extends SettingsEntry> {
  key: string;
  section: T;
  /** Absent when the result is the submenu itself. */
  setting?: SettingDescriptor;
  label: string;
  /** Where a setting lives ("Playback › Up next"); a submenu's blurb. */
  path: string;
  ranges: MatchRange[];
}

/** How far below a label each kind of evidence ranks. */
const WEIGHT = { alias: 2, english: 3, place: 4, englishPlace: 5, prose: 6 } as const;

/** Alias values are comma-separated lists; a missing key contributes nothing. */
function aliasText(keys: readonly string[] | undefined, translate: (key: string) => string): string {
  return (keys ?? [])
    .flatMap((key) => {
      const value = translate(key);
      return value === key ? [] : [value];
    })
    .join(', ');
}

function field(text: string | undefined, weight: number): SearchField[] {
  return text ? [{ text, weight }] : [];
}

function sectionDoc<T extends SettingsEntry>(
  section: T,
  catalog: SectionCatalog | undefined,
  english: boolean,
): SearchDoc<SettingsSearchResult<T>> {
  const label = section.title();
  const blurb = section.blurb();
  return {
    value: { key: section.id, section, label, path: blurb, ranges: [] },
    label,
    fields: [
      ...field(aliasText(catalog?.aliases, t), WEIGHT.alias),
      ...field(catalog?.terms?.join(', '), WEIGHT.alias),
      ...(english && catalog
        ? [
            ...field(tEn(catalog.title), WEIGHT.english),
            ...field(aliasText(catalog.aliases, tEn), WEIGHT.english),
          ]
        : []),
      ...field(blurb, WEIGHT.prose),
    ],
  };
}

function settingDoc<T extends SettingsEntry>(
  section: T,
  catalog: SectionCatalog,
  setting: SettingDescriptor,
  english: boolean,
): SearchDoc<SettingsSearchResult<T>> {
  const label = t(setting.label);
  const place = section.title();
  const group = setting.group ? t(setting.group) : '';
  const path = [place, group]
    .filter((part, index, parts) => part && part !== label && parts.indexOf(part) === index)
    .join(' › ');
  return {
    value: { key: `${section.id}/${setting.id}`, section, setting, label, path, ranges: [] },
    label,
    fields: [
      ...field(aliasText(setting.aliases, t), WEIGHT.alias),
      ...field(setting.terms?.join(', '), WEIGHT.alias),
      ...(english
        ? [
            ...field(tEn(setting.label), WEIGHT.english),
            ...field(aliasText(setting.aliases, tEn), WEIGHT.english),
          ]
        : []),
      ...field([place, group].join(', '), WEIGHT.place),
      ...(english
        ? field([tEn(catalog.title), setting.group ? tEn(setting.group) : ''].join(', '), WEIGHT.englishPlace)
        : []),
      ...field(setting.hint ? t(setting.hint) : undefined, WEIGHT.prose),
    ],
  };
}

/**
 * Search every submenu and every setting inside them, the way a phone's
 * settings search does. `null` means "not searching" — the caller shows the
 * grouped index. An empty array means the query genuinely matched nothing.
 *
 * Only what this account can reach is offered: `sections` is already filtered
 * by role, and `capabilities` removes the rows a submenu would not draw.
 */
export function searchSettings<T extends SettingsEntry>(
  sections: T[],
  capabilities: SettingCapabilities,
  query: string,
  catalog: Record<string, SectionCatalog> = SETTINGS_CATALOG,
): SettingsSearchResult<T>[] | null {
  const english = locale() !== 'en';
  const docs: SearchDoc<SettingsSearchResult<T>>[] = sections.map((section) =>
    sectionDoc(section, sectionCatalog(section.id, catalog), english),
  );
  for (const section of sections) {
    const entry = sectionCatalog(section.id, catalog);
    for (const setting of entry?.settings ?? []) {
      if (setting.requires && !capabilities[setting.requires]) continue;
      docs.push(settingDoc(section, entry!, setting, english));
    }
  }
  const hits = rankDocs(docs, query);
  return hits && hits.map((hit) => ({ ...hit.value, ranges: hit.ranges }));
}

/** Groups in declared order, resolved against what this account can open. */
export function groupSections<T extends SettingsEntry>(
  sections: T[],
  groups: SettingsGroupSpec[],
): { label: string; sections: T[] }[] {
  return groups
    .map((group) => ({
      label: group.label(),
      sections: group.ids
        .map((id) => sections.find((section) => section.id === id))
        .filter((section): section is T => Boolean(section)),
    }))
    .filter((group) => group.sections.length > 0);
}
