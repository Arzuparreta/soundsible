import type { JSX } from 'solid-js';
import { t } from '../lib/i18n';

export interface PrimaryNavItem {
  href: string;
  label: () => string;
  end?: boolean;
  icon: () => JSX.Element;
}

const search: PrimaryNavItem = {
  href: '/search',
  label: () => t('nav.search'),
  icon: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  ),
};

const library: PrimaryNavItem = {
  href: '/',
  label: () => t('nav.library'),
  end: true,
  icon: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 19a2 2 0 0 1 2-2h12" />
      <path d="M6 2h12v20H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" />
    </svg>
  ),
};

const playlists: PrimaryNavItem = {
  href: '/playlists',
  label: () => t('nav.playlists'),
  icon: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M9 6h11M9 12h11M9 18h7M5 6v.01M5 12v.01M5 18v.01" />
    </svg>
  ),
};

const podcasts: PrimaryNavItem = {
  href: '/podcasts',
  label: () => t('nav.podcasts'),
  icon: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="11" r="1" />
      <path d="M17.7 17.7A8 8 0 1 0 12 20v-5M15.5 14.5a5 5 0 1 0-7 0" />
    </svg>
  ),
};

const settings: PrimaryNavItem = {
  href: '/settings',
  label: () => t('nav.settings'),
  icon: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
};

/** The same five product destinations on mobile and desktop. */
export const primaryNavigation: PrimaryNavItem[] = [
  search,
  library,
  playlists,
  podcasts,
  settings,
];

export const desktopNavigation = primaryNavigation;
