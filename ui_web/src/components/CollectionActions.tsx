import { createSignal, Show } from 'solid-js';
import { player } from '../stores/player';
import { useCatalogCollection } from '../lib/catalogItem';
import { t } from '../lib/i18n';
import type { CatalogItem, Track } from '../types/music';
import { PlayIcon } from './icons';
import styles from './CollectionActions.module.css';
import { Spinner } from './Spinner';

/** A collection page's primary button during a DJ session: a collection is one
 * source for the DJ, so pressing it starts a new session from that collection.
 * Catalog songs are matched first, with the same resolver song rows use. */
export function CollectionActions(props: {
  title: string;
  buttonClass?: string;
  iconOnlyOnMobile?: boolean;
  tracks?: Track[];
  items?: CatalogItem[];
}) {
  const [busy, setBusy] = createSignal(false);
  const count = () => props.items?.length ?? props.tracks?.length ?? 0;
  const start = async () => {
    if (busy()) return;
    const epoch = player().actions.beginAutoSessionChange();
    setBusy(true);
    try {
      if (props.items) await useCatalogCollection(props.items, props.title, 'start', undefined, () => true, epoch);
      else player().actions.startDjSelection(props.tracks ?? [], props.title);
    } finally { setBusy(false); }
  };
  const label = () => busy() ? t('collection.resolving') : t('autoMode.startDj');
  return (
    <button class={props.buttonClass} classList={{ [styles.iconOnMobile]: props.iconOnlyOnMobile }} type="button" data-glyph-label disabled={busy() || !count()} aria-busy={busy()}
      aria-label={label()} title={t('autoMode.startDj')} onClick={() => void start()}>
      <span class={styles.content}>
        <Show when={!busy()} fallback={<Spinner size={18} />}><PlayIcon size={16} /></Show>
        <span class={styles.label}>{label()}</span>
      </span>
    </button>
  );
}
