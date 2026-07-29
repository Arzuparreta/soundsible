import { For, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { downloadCounts } from '../stores';
import { t } from '../lib/i18n';
import { primaryNavigation, type PrimaryNavItem } from './primaryNavigation';
import styles from './Sidebar.module.css';

/** Secondary library shortcuts shared by the desktop rail only. */
const shortcuts: PrimaryNavItem[] = [
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
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" />
      </svg>
    ),
  },
];

function Item(props: { item: PrimaryNavItem; badge?: number }) {
  return (
    <A href={props.item.href} end={props.item.end} class={styles.item} activeClass={styles.active}>
      <span class={styles.icon}>{props.item.icon()}</span>
      <span class={styles.label}>{props.item.label()}</span>
      <Show when={props.badge}>
        <span class={styles.badge}>{props.badge}</span>
      </Show>
    </A>
  );
}

/** Desktop-only left navigation rail. Its primary group is the exact same
 *  source as the mobile tab bar; only secondary library shortcuts are extra. */
export function Sidebar() {
  const active = () => downloadCounts().active;
  return (
    <aside class={styles.sidebar}>
      <A href="/" end class={styles.brand}>
        {/* viewBox trimmed to the glyph's bounding box so the S lands on the nav
            icon column instead of floating inside the logo's original padding. */}
        <svg
          class={styles.mark}
          viewBox="87 184.45 184.63 265.55"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M 180.45388,450 Q 152.34172,450 131.0678,440.79419 110.17346,431.58838 98.396774,414.59302 87,397.2436 87,373.52093 h 46.7267 q 0,17.34941 12.53676,27.61744 12.91604,10.26803 34.19042,10.26803 20.51386,0 32.29059,-9.91396 12.15658,-10.26802 12.15658,-27.26338 0,-12.74651 -7.97764,-22.30639 -7.59783,-9.91396 -22.03392,-13.45466 l -37.22955,-8.85174 q -30.0115,-7.0814 -47.48648,-26.55523 -17.475073,-19.47385 -17.475073,-46.38315 0,-32.9285 23.173483,-52.40233 23.17354,-19.82791 61.92266,-19.82791 26.21236,0 45.58691,8.85175 19.75481,8.85174 30.39174,25.13895 10.63695,15.93314 10.63695,37.5314 H 218.0632 q 0,-14.87093 -11.01709,-24.07675 -11.01682,-9.20582 -29.25158,-9.20582 -17.85499,0 -28.49194,9.20582 -10.25718,8.85174 -10.25718,23.36861 0,12.03838 7.21805,19.82791 7.59782,7.78954 20.89412,11.33023 l 38.36893,8.85175 q 30.77144,7.08139 48.24667,28.32558 17.85499,21.24419 17.85499,50.63198 0,23.01454 -11.39697,40.00989 -11.01671,16.99535 -31.53106,26.55524 Q 208.18578,450 180.45388,450 Z" />
        </svg>
        <span class={styles.wordmark}>Soundsible</span>
      </A>

      <nav class={styles.group}>
        <For each={primaryNavigation}>{(item) => <Item item={item} />}</For>
      </nav>

      <p class={styles.heading}>{t('nav.shortcuts')}</p>
      <nav class={styles.group}>
        <For each={shortcuts}>
          {(item) => <Item item={item} badge={item.href === '/downloads' ? active() : undefined} />}
        </For>
      </nav>

      <div class={styles.spacer} />
    </aside>
  );
}
