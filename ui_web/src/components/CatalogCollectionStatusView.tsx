import { Show } from 'solid-js';
import { PinIcon } from './icons';
import styles from './CatalogCollectionStatus.module.css';

export function CatalogCollectionStatusView(props: { label: string; bookmarked?: boolean }) {
  return <Show when={props.label}>{label => <span class={styles.status}><Show when={props.bookmarked}><PinIcon size={12} filled class={styles.pin} /></Show>{label()}</span>}</Show>;
}
