import { Show } from 'solid-js';
import { catalogCollectionLabel } from '../lib/catalogCollection';
import type { CatalogItem } from '../types/music';
import styles from './CatalogCollectionStatus.module.css';

export function CatalogCollectionStatus(props: { item: CatalogItem }) {
  return <Show when={catalogCollectionLabel(props.item)}>{label => <span class={styles.status}>{label()}</span>}</Show>;
}
