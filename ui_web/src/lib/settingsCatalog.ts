import { LOCALES } from './i18n';

/**
 * Every setting the settings search can land on, as data.
 *
 * The registry in `SettingsSections.tsx` draws the rows; this says what each
 * row is called and where it lives, so the search can list individual settings
 * the way iOS and Android do. Strings are i18n keys, resolved at search time in
 * the active language and in English.
 *
 * The two halves are tied by types rather than by hope: a section id without an
 * entry here does not compile, and neither does a row whose `anchor` is not one
 * of the ids below. `settingsCatalog.test.ts` covers the remaining direction —
 * every id here is rendered somewhere, so no result leads nowhere.
 */

/** What an account or install must have for a setting to be offered at all. */
export type SettingRequirement = 'admin' | 'sharedLinks';

export interface SettingDescriptor {
  /** The row's anchor: `data-setting` in the DOM, unique across the catalog. */
  readonly id: string;
  /** The row's own label. */
  readonly label: string;
  /** The label of the group the row sits in, for the result's path. */
  readonly group?: string;
  /** The note or hint explaining the row. Matched, but weighed lightly. */
  readonly hint?: string;
  /** Keys whose values are extra words for this row, comma-separated. */
  readonly aliases?: readonly string[];
  /** Words that are the same in every language: product and format names. */
  readonly terms?: readonly string[];
  readonly requires?: SettingRequirement;
}

export interface SectionCatalog {
  readonly title: string;
  readonly blurb: string;
  readonly aliases?: readonly string[];
  readonly terms?: readonly string[];
  readonly settings: readonly SettingDescriptor[];
}

export const SETTINGS_CATALOG = {
  account: {
    title: 'account.title',
    blurb: 'settings.blurb.account',
    settings: [
      { id: 'change-name', label: 'account.changeName', group: 'settings.group.profile' },
      {
        id: 'change-username',
        label: 'account.changeUsername',
        group: 'settings.group.profile',
        hint: 'account.usernameHint',
      },
      {
        id: 'change-password',
        label: 'account.changePassword',
        group: 'settings.group.profile',
        aliases: ['settings.searchAliases.password'],
      },
      { id: 'sign-out', label: 'account.signOut', aliases: ['settings.searchAliases.signOut'] },
    ],
  },
  appearance: {
    title: 'settings.appearance',
    blurb: 'settings.blurb.appearance',
    settings: [
      {
        id: 'theme',
        label: 'settings.theme',
        hint: 'settings.note.theme',
        aliases: [
          'settings.themeDark',
          'settings.themeLight',
          'settings.themeSystem',
          'settings.searchAliases.theme',
        ],
      },
      {
        id: 'other-themes',
        label: 'settings.otherThemes',
        aliases: ['settings.themeSlate', 'settings.themePureBlack', 'settings.themeForestGreen'],
      },
      {
        id: 'language',
        label: 'settings.language',
        aliases: ['settings.searchAliases.language'],
        terms: LOCALES.flatMap((l) => [l.label, l.native]),
      },
    ],
  },
  accessibility: {
    title: 'accessibility.title',
    blurb: 'settings.blurb.accessibility',
    settings: [
      {
        id: 'interface-size',
        label: 'accessibility.interfaceSize',
        aliases: [
          'accessibility.size.compact',
          'accessibility.size.large',
          'settings.searchAliases.interfaceSize',
        ],
      },
      {
        id: 'high-contrast',
        label: 'accessibility.highContrast',
        hint: 'accessibility.highContrastNote',
        aliases: ['settings.searchAliases.highContrast'],
      },
      {
        id: 'bottom-bar',
        label: 'nav.bottomBar',
        hint: 'nav.bottomBarHint',
        aliases: ['settings.searchAliases.bottomBar'],
      },
      {
        id: 'haptics',
        label: 'settings.haptics',
        group: 'settings.group.feedback',
        hint: 'settings.note.haptics',
        aliases: ['settings.searchAliases.haptics'],
      },
    ],
  },
  playback: {
    title: 'settings.playback',
    blurb: 'settings.blurb.playback',
    settings: [
      {
        id: 'delivery',
        label: 'settings.link.label',
        group: 'settings.group.connection',
        hint: 'settings.note.connection',
        aliases: ['settings.searchAliases.delivery'],
      },
      {
        id: 'volume-leveling',
        label: 'settings.volumeLeveling',
        group: 'settings.playback',
        hint: 'settings.note.volumeLeveling',
        aliases: ['settings.volumeLevelingSearch'],
        terms: ['ReplayGain'],
      },
      {
        id: 'autoplay',
        label: 'settings.autoplay',
        group: 'settings.group.upNext',
        hint: 'settings.note.autoplay',
        aliases: ['settings.searchAliases.autoplay'],
      },
      {
        id: 'learn-activity',
        label: 'settings.learnActivity',
        group: 'settings.group.recommendations',
        hint: 'settings.learnActivityNote',
        aliases: ['settings.discovery', 'settings.searchAliases.learnActivity'],
      },
      {
        id: 'reset-learning',
        label: 'settings.resetLearning',
        group: 'settings.group.recommendations',
        hint: 'settings.resetLearningConfirm',
      },
    ],
  },
  library: {
    title: 'settings.libraryCard',
    blurb: 'settings.blurb.library',
    settings: [
      { id: 'track-count', label: 'settings.tracks' },
      { id: 'reload', label: 'settings.reload', group: 'settings.group.sync', hint: 'settings.note.sync' },
      {
        id: 'rescan',
        label: 'settings.rescan',
        group: 'settings.group.sync',
        hint: 'settings.note.sync',
        aliases: ['settings.searchAliases.rescan'],
      },
      { id: 'cloud-sync', label: 'settings.sync', group: 'settings.group.sync', requires: 'admin' },
      {
        id: 'import',
        label: 'settings.importFrom',
        group: 'settings.importCard',
        hint: 'settings.importNote',
        aliases: ['settings.searchAliases.import'],
        terms: ['Spotify', 'Apple Music'],
      },
      {
        id: 'repair',
        label: 'settings.repair',
        group: 'settings.group.maintenance',
        hint: 'settings.repairMsg',
      },
      {
        id: 'optimize',
        label: 'settings.optimize',
        group: 'settings.group.maintenance',
        hint: 'settings.note.maintenance',
        requires: 'admin',
      },
      {
        id: 'purge-missing',
        label: 'settings.purgeFiles',
        group: 'settings.group.maintenance',
        hint: 'settings.note.maintenance',
      },
      {
        id: 'empty-library',
        label: 'settings.emptyLibrary',
        group: 'settings.group.maintenance',
        hint: 'settings.emptyLibraryMsg',
        aliases: ['settings.searchAliases.emptyLibrary'],
        requires: 'admin',
      },
    ],
  },
  downloads: {
    title: 'settings.downloads',
    blurb: 'settings.blurb.downloads',
    settings: [
      {
        id: 'quality',
        label: 'settings.quality',
        hint: 'settings.note.quality',
        aliases: [
          'settings.qualityLow',
          'settings.qualityHigh',
          'settings.searchAliases.quality',
        ],
      },
      {
        id: 'lossless-upgrades',
        label: 'settings.losslessUpgrades',
        group: 'settings.losslessStatusLabel',
        hint: 'settings.losslessNote',
        aliases: ['settings.searchAliases.lossless'],
      },
      {
        id: 'lossless-status',
        label: 'settings.losslessState',
        group: 'settings.losslessStatusLabel',
        aliases: ['settings.losslessPending', 'settings.losslessUpgraded'],
      },
      {
        id: 'lossless-jamendo',
        label: 'settings.losslessJamendoClientId',
        group: 'settings.losslessStatusLabel',
        hint: 'settings.losslessJamendoHint',
        terms: ['Jamendo'],
      },
      {
        id: 'lossless-run',
        label: 'settings.losslessRunNow',
        group: 'settings.losslessStatusLabel',
        hint: 'settings.losslessRunNowHint',
        aliases: ['settings.searchAliases.lossless'],
      },
      {
        id: 'lossless-recheck',
        label: 'settings.losslessRecheck',
        group: 'settings.losslessStatusLabel',
        hint: 'settings.losslessRecheckHint',
      },
      {
        id: 'auto-update-ytdlp',
        label: 'settings.autoUpdateYtdlp',
        group: 'settings.group.updates',
        hint: 'settings.note.updates',
        terms: ['yt-dlp', 'YouTube'],
      },
      {
        id: 'auto-update-curl-cffi',
        label: 'settings.autoUpdateCurlCffi',
        group: 'settings.group.updates',
        hint: 'settings.note.updates',
        terms: ['curl-cffi'],
      },
    ],
  },
  devices: {
    title: 'settings.devices',
    blurb: 'settings.blurb.devices',
    settings: [
      {
        id: 'device-name',
        label: 'settings.deviceName',
        group: 'settings.group.thisDevice',
        hint: 'settings.note.device',
        aliases: ['settings.searchAliases.deviceName'],
      },
      {
        id: 'shared-links',
        label: 'settings.openSharedLinks',
        group: 'settings.group.thisDevice',
        hint: 'settings.sharedLinks',
        requires: 'sharedLinks',
      },
      {
        id: 'paired-devices',
        label: 'settings.pairedDevices',
        hint: 'settings.pairNote',
        aliases: ['settings.searchAliases.pairedDevices'],
      },
      { id: 'network-devices', label: 'settings.group.network', hint: 'settings.note.network' },
    ],
  },
  users: {
    title: 'users.title',
    blurb: 'settings.blurb.users',
    aliases: ['account.manageUsers', 'settings.searchAliases.users'],
    settings: [
      { id: 'invite', label: 'users.invite', hint: 'users.inviteHint' },
      {
        id: 'add-user',
        label: 'users.addTitle',
        aliases: ['users.roleAdmin', 'users.roleMember'],
      },
    ],
  },
  subsonic: {
    title: 'subsonic.title',
    blurb: 'settings.blurb.subsonic',
    terms: ['Subsonic', 'OpenSubsonic', 'Symfonium', 'Amperfy', 'Feishin', 'DSub', 'Tempo'],
    settings: [
      { id: 'subsonic-server', label: 'subsonic.server', group: 'subsonic.title', hint: 'subsonic.note' },
      { id: 'subsonic-username', label: 'subsonic.username', group: 'subsonic.title' },
      { id: 'subsonic-copy-server', label: 'subsonic.copyServer', group: 'subsonic.title' },
      {
        id: 'subsonic-password',
        label: 'subsonic.password',
        hint: 'subsonic.passwordNote',
        aliases: ['subsonic.generate', 'subsonic.revoke'],
      },
    ],
  },
  community: {
    title: 'settings.community',
    blurb: 'settings.blurb.community',
    terms: ['Live'],
    settings: [
      {
        id: 'community-service',
        label: 'settings.communityService',
        group: 'settings.community',
        hint: 'settings.note.community',
        aliases: ['settings.communityRelay'],
      },
      { id: 'community-status', label: 'settings.communityStatus', group: 'settings.community' },
    ],
  },
  about: {
    title: 'settings.about',
    blurb: 'settings.blurb.about',
    settings: [
      { id: 'engine-status', label: 'settings.engineLabel', group: 'settings.connection' },
      {
        id: 'version',
        label: 'brand.soundsible',
        group: 'settings.about',
        aliases: ['settings.searchAliases.version'],
      },
      { id: 'design-system', label: 'settings.viewDesign', group: 'settings.about' },
    ],
  },
} as const satisfies Record<string, SectionCatalog>;

export type SettingsSectionId = keyof typeof SETTINGS_CATALOG;

/** Every anchor a settings row may carry. */
export type SettingAnchor =
  (typeof SETTINGS_CATALOG)[SettingsSectionId]['settings'][number]['id'];

/** Which requirements the signed-in account and this install meet. */
export type SettingCapabilities = Record<SettingRequirement, boolean>;

export function sectionCatalog(
  id: string,
  catalog: Record<string, SectionCatalog> = SETTINGS_CATALOG,
): SectionCatalog | undefined {
  return Object.prototype.hasOwnProperty.call(catalog, id) ? catalog[id] : undefined;
}
