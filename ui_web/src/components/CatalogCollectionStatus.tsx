import { catalogCollectionLabel } from '../lib/catalogCollection';
import type { CatalogItem } from '../types/music';
import { CatalogCollectionStatusView } from './CatalogCollectionStatusView';

export function CatalogCollectionStatus(props: { item: CatalogItem }) {
  return <CatalogCollectionStatusView label={catalogCollectionLabel(props.item)} />;
}
