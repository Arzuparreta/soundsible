import { For, type JSX } from 'solid-js';
import { A } from '@solidjs/router';
import styles from './TabBar.module.css';

interface Tab {
  href: string;
  label: string;
  end?: boolean;
  icon: () => JSX.Element;
}

const tabs: Tab[] = [
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
  {
    href: '/settings',
    label: 'Ajustes',
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 13a7.9 7.9 0 000-2l2-1.5-2-3.4-2.3 1a8 8 0 00-1.7-1L15 3.5h-4l-.4 2.6a8 8 0 00-1.7 1l-2.3-1-2 3.4L6.6 11a7.9 7.9 0 000 2l-2 1.5 2 3.4 2.3-1a8 8 0 001.7 1l.4 2.6h4l.4-2.6a8 8 0 001.7-1l2.3 1 2-3.4z" />
      </svg>
    ),
  },
];

export function TabBar() {
  return (
    <nav class={styles.bar}>
      <For each={tabs}>
        {(t) => (
          <A href={t.href} end={t.end} class={styles.tab} activeClass={styles.active}>
            {t.icon()}
            <span class={styles.label}>{t.label}</span>
          </A>
        )}
      </For>
    </nav>
  );
}
