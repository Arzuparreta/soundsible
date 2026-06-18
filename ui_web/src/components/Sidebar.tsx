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
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 13a7.9 7.9 0 000-2l2-1.5-2-3.4-2.3 1a8 8 0 00-1.7-1L15 3.5h-4l-.4 2.6a8 8 0 00-1.7 1l-2.3-1-2 3.4L6.6 11a7.9 7.9 0 000 2l-2 1.5 2 3.4 2.3-1a8 8 0 001.7 1l.4 2.6h4l.4-2.6a8 8 0 001.7-1l2.3 1 2-3.4z" />
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
        <span class={styles.mark}>S</span>
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
