import { For, Show, type JSX } from 'solid-js';
import { A } from '@solidjs/router';
import { downloadCounts } from '../stores';
import styles from './Sidebar.module.css';

interface NavItem {
  href: string;
  label: string;
  end?: boolean;
  icon: () => JSX.Element;
}

/** Primary navigation (top of sidebar). */
const primary: NavItem[] = [
  {
    href: '/',
    label: 'Inicio',
    end: true,
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 11l9-8 9 8M5 10v10h14V10" />
      </svg>
    ),
  },
  {
    href: '/search',
    label: 'Buscar',
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.3-4.3" />
      </svg>
    ),
  },
  {
    href: '/discover',
    label: 'Discover',
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="9" />
        <path d="M15 9l-2 4-4 2 2-4z" />
      </svg>
    ),
  },
];

/** Library section (bottom group). */
const library: NavItem[] = [
  {
    href: '/favourites',
    label: 'Favoritos',
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 21s-7-4.35-9.5-8.5C.9 9.6 2.2 6 5.5 6 7.6 6 9 7.5 12 10c3-2.5 4.4-4 6.5-4 3.3 0 4.6 3.6 3 6.5C19 16.65 12 21 12 21z" />
      </svg>
    ),
  },
  {
    href: '/playlists',
    label: 'Listas',
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M4 7h11M4 12h11M4 17h7M18 16v-6l3 1.5" />
      </svg>
    ),
  },
  {
    href: '/podcasts',
    label: 'Podcasts',
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M6 11a6 6 0 0012 0M12 17v4" />
      </svg>
    ),
  },
  {
    href: '/downloads',
    label: 'Descargas',
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" />
      </svg>
    ),
  },
];

const settings: NavItem = {
  href: '/settings',
  label: 'Ajustes',
  icon: () => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
};

function Item(props: { item: NavItem; badge?: number }) {
  return (
    <A href={props.item.href} end={props.item.end} class={styles.item} activeClass={styles.active}>
      <span class={styles.icon}>{props.item.icon()}</span>
      <span class={styles.label}>{props.item.label}</span>
      <Show when={props.badge}>
        <span class={styles.badge}>{props.badge}</span>
      </Show>
    </A>
  );
}

/** Desktop-only left navigation rail. Mirrors the bottom TabBar's IA plus the
 *  library shortcuts that live behind Home chips on mobile. */
export function Sidebar() {
  const active = () => downloadCounts().active;
  return (
    <aside class={styles.sidebar}>
      <A href="/" end class={styles.brand}>
        <svg class={styles.mark} viewBox="22 160 314 314" fill="currentColor" aria-hidden="true">
          <path d="M 180.45388,450 Q 152.34172,450 131.0678,440.79419 110.17346,431.58838 98.396774,414.59302 87,397.2436 87,373.52093 h 46.7267 q 0,17.34941 12.53676,27.61744 12.91604,10.26803 34.19042,10.26803 20.51386,0 32.29059,-9.91396 12.15658,-10.26802 12.15658,-27.26338 0,-12.74651 -7.97764,-22.30639 -7.59783,-9.91396 -22.03392,-13.45466 l -37.22955,-8.85174 q -30.0115,-7.0814 -47.48648,-26.55523 -17.475073,-19.47385 -17.475073,-46.38315 0,-32.9285 23.173483,-52.40233 23.17354,-19.82791 61.92266,-19.82791 26.21236,0 45.58691,8.85175 19.75481,8.85174 30.39174,25.13895 10.63695,15.93314 10.63695,37.5314 H 218.0632 q 0,-14.87093 -11.01709,-24.07675 -11.01682,-9.20582 -29.25158,-9.20582 -17.85499,0 -28.49194,9.20582 -10.25718,8.85174 -10.25718,23.36861 0,12.03838 7.21805,19.82791 7.59782,7.78954 20.89412,11.33023 l 38.36893,8.85175 q 30.77144,7.08139 48.24667,28.32558 17.85499,21.24419 17.85499,50.63198 0,23.01454 -11.39697,40.00989 -11.01671,16.99535 -31.53106,26.55524 Q 208.18578,450 180.45388,450 Z" />
        </svg>
        <span class={styles.wordmark}>Soundsible</span>
      </A>

      <nav class={styles.group}>
        <For each={primary}>{(item) => <Item item={item} />}</For>
      </nav>

      <p class={styles.heading}>Biblioteca</p>
      <nav class={styles.group}>
        <For each={library}>
          {(item) => <Item item={item} badge={item.href === '/downloads' ? active() : undefined} />}
        </For>
      </nav>

      <div class={styles.spacer} />
      <nav class={styles.group}>
        <Item item={settings} />
      </nav>
    </aside>
  );
}
