import type { JSX } from 'solid-js';
import { t } from '../lib/i18n';
import { DownloadIcon, menuIcons } from './icons';

export interface PrimaryNavItem {
  href: string;
  label: () => string;
  end?: boolean;
  icon: () => JSX.Element;
}

/** Canonical destinations and icons; desktop and mobile choose their own grouping. */
export const primaryNavigation: PrimaryNavItem[] = [
  {
    href: '/', label: () => t('nav.library'), end: true,
    icon: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" /></svg>,
  },
  {
    href: '/search',
    label: () => t('nav.search'),
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.3-4.3" />
      </svg>
    ),
  },
  {
    href: '/live',
    label: () => t('nav.live'),
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M8.5 8.5a5 5 0 017 7M5.7 5.7a9 9 0 0112.6 12.6" />
        <circle cx="12" cy="12" r="2" />
      </svg>
    ),
  },
  {
    href: '/playlists',
    label: () => t('nav.playlists'),
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9 6h11M9 12h11M9 18h7M5 6v.01M5 12v.01M5 18v.01" />
      </svg>
    ),
  },
  {
    href: '/settings',
    label: () => t('nav.settings'),
    icon: () => (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    ),
  },
];

/** Library destinations reused by the desktop rail and mobile menus. */
export const libraryShortcuts: PrimaryNavItem[] = [
  {
    href: '/podcasts',
    label: () => t('nav.podcasts'),
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="11" r="1" />
        <path d="M17.7 17.7A8 8 0 1012 20v-5M15.5 14.5a5 5 0 10-7 0" />
      </svg>
    ),
  },
  {
    href: '/favourites',
    label: () => t('nav.favourites'),
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 21s-7-4.35-9.5-8.5C.9 9.6 2.2 6 5.5 6 7.6 6 9 7.5 12 10c3-2.5 4.4-4 6.5-4 3.3 0 4.6 3.6 3 6.5C19 16.65 12 21 12 21z" />
      </svg>
    ),
  },
  {
    href: '/downloads',
    label: () => t('nav.downloads'),
    icon: () => <DownloadIcon />,
  },
];

/** Direct collection destinations are also selectable in the bottom bar. */
export const libraryViews: PrimaryNavItem[] = [
  { href: '/library?view=songs', label: () => t('library.songs'), icon: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/></svg> },
  { href: '/library?view=albums', label: () => t('library.albums'), icon: menuIcons.album },
  { href: '/library?view=artists', label: () => t('library.artists'), icon: menuIcons.artist },
  { href: '/?saved=albums', label: () => t('savedEntities.albums'), icon: menuIcons.album },
  { href: '/?saved=artists', label: () => t('savedEntities.artists'), icon: menuIcons.artist },
];
export const navigationItems = [...primaryNavigation, ...libraryShortcuts, ...libraryViews];
export const defaultBottomNavigation = ['/', '/favourites', '/search', '/settings'];
export function mobileNavGroup(path: string, search = ''): string {
  const params = new URLSearchParams(search);
  if (path === '/library' && ['songs', 'albums', 'artists'].includes(params.get('view') ?? '')) return `/library?view=${params.get('view')}`;
  if (['/', '/library'].includes(path) && ['albums', 'artists'].includes(params.get('saved') ?? '')) return `/?saved=${params.get('saved')}`;
  if (path === '/') return '/';
  if (path === '/library' || /^\/(album|artist)\//.test(path)) return '/';
  return navigationItems.find(item => item.href !== '/' && (path === item.href || path.startsWith(`${item.href}/`)))?.href ?? path;
}
export const navigationGroups = [
  { label: () => t('nav.yourMusic'), hrefs: ['/', '/favourites', '/playlists'] },
  { label: () => t('nav.explore'), hrefs: ['/search', '/podcasts', '/live'] },
  { label: () => t('nav.application'), hrefs: ['/downloads', '/settings'] },
];
