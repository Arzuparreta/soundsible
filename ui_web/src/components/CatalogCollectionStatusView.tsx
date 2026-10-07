import { Show } from 'solid-js';
import styles from './CatalogCollectionStatus.module.css';

export function CatalogCollectionStatusView(props: { label: string }) {
  return <Show when={props.label}>{label => <span class={styles.status}>{label()}</span>}</Show>;
}
