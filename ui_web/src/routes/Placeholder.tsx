import { createSignal, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { t } from '../lib/i18n';
import { useAppBar } from '../lib/appBar';
import button from '../components/Button.module.css';
import styles from './Placeholder.module.css';

/**
 * The page for an address no route answers. It says so and offers the two
 * places a listener most likely meant to be: their library and Discover.
 */
export function Placeholder(props: { title: string; blurb?: string }) {
  const [heading, setHeading] = createSignal<HTMLElement>();
  useAppBar({ title: () => props.title, heading });

  return (
    <section class={styles.page}>
      <h1 ref={setHeading} class={styles.title}>{props.title}</h1>
      <Show when={props.blurb}>
        <p class={styles.blurb}>{props.blurb}</p>
      </Show>
      <div class={styles.actions}>
        <A href="/library" class={`${button.btn} ${button.primary} ${button.md}`}>{t('nav.library')}</A>
        <A href="/search" class={`${button.btn} ${button.secondary} ${button.md}`}>{t('nav.search')}</A>
      </div>
    </section>
  );
}
