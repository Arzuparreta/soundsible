import { normalizeLibraryQuery } from './librarySearch';

/**
 * The rules that turn the settings registry into an index: who may open what,
 * how the submenus are grouped, and what a search matches. Pure on purpose —
 * the registry itself drags in the whole app, this does not.
 */
export interface SettingsEntry {
  id: string;
  title: () => string;
  blurb: () => string;
  /** Admin-only entries act on the shared server, not on this account. */
  adminOnly?: boolean;
  /** The labels living inside the submenu, so search can find them from here. */
  keywords: () => string[];
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

/**
 * `null` means "not searching" — the caller shows the grouped index. An empty
 * array means the query genuinely matched nothing.
 */
export function matchSections<T extends SettingsEntry>(sections: T[], query: string): T[] | null {
  const needle = normalizeLibraryQuery(query);
  if (!needle) return null;
  return sections.filter((section) =>
    [section.title(), section.blurb(), ...section.keywords()].some((label) =>
      normalizeLibraryQuery(label).includes(needle),
    ),
  );
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
