import { SETTINGS_CATALOG, type SectionCatalog } from '../lib/settingsCatalog';
import { searchSettings, type SettingsEntry, type SettingsSearchResult } from '../lib/settingsIndex';
import { t } from '../lib/i18n';

export type NativeSettingsTab = 'account' | 'appearance' | 'accessibility' | 'recommendations' | 'playback' | 'library' | 'downloads'
  | 'subsonic' | 'users' | 'devices' | 'community' | 'about';

/** Rows the web draws that have no Android equivalent: its own bottom bar, its link-association page, its design preview. */
const WEB_ONLY = new Set(['bottom-bar', 'shared-links', 'design-system']);
/** Android keeps recommendation learning in its own tab; everything else lives where the web puts it. */
const TAB_FOR_SETTING: Record<string, NativeSettingsTab> = { 'learn-activity': 'recommendations', 'reset-learning': 'recommendations' };

const NATIVE_CATALOG: Record<string, SectionCatalog> = Object.fromEntries(Object.entries(SETTINGS_CATALOG).map(([id, section]) =>
  [id, { ...section, settings: section.settings.filter(setting => !WEB_ONLY.has(setting.id)) }]));

/** The web's settings search over what this app draws, for this account. */
export function searchNativeSettings(query: string, options: { admin: boolean; subsonic: boolean; devices: boolean }):
  { key: string; label: string; path: string; tab: NativeSettingsTab; anchor?: string }[] | null {
  const sections: (SettingsEntry & { id: NativeSettingsTab })[] = (Object.keys(NATIVE_CATALOG) as NativeSettingsTab[])
    .filter(id => (id !== 'subsonic' || options.subsonic) && (id !== 'devices' || options.devices))
    .map(id => ({ id, title: () => t(NATIVE_CATALOG[id].title as Parameters<typeof t>[0]), blurb: () => t(NATIVE_CATALOG[id].blurb as Parameters<typeof t>[0]),
      adminOnly: id === 'downloads' || id === 'users' }))
    .filter(section => !section.adminOnly || options.admin);
  const results = searchSettings(sections, { admin: options.admin, sharedLinks: false }, query, NATIVE_CATALOG) as SettingsSearchResult<SettingsEntry & { id: NativeSettingsTab }>[] | null;
  return results && results.map(result => ({ key: result.key, label: result.label, path: result.path,
    tab: (result.setting && TAB_FOR_SETTING[result.setting.id]) || result.section.id, anchor: result.setting?.id }));
}
