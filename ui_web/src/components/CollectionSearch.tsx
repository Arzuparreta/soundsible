import { createMemo, createSignal, type Accessor } from 'solid-js';
import { t } from '../lib/i18n';
import { filterLocalCollection, normalizeLibraryQuery, type SearchFieldValue } from '../lib/librarySearch';
import { EmptyState } from './EmptyState';
import { SearchField } from './SearchField';
import styles from './CollectionSearch.module.css';

/** Filters available rows in place. The source array still owns their order and identity. */
export function createCollectionSearch() {
  const [value, setValue] = createSignal('');
  const query = createMemo(() => normalizeLibraryQuery(value()));

  function filter<T>(items: Accessor<T[]>, fields: (item: T) => SearchFieldValue[]) {
    return createMemo(() => filterLocalCollection(items(), query(), fields));
  }

  return { value, setValue, query, filter };
}

export function CollectionSearch(props: {
  search: ReturnType<typeof createCollectionSearch>;
  placeholder?: string;
  inset?: boolean;
  toolbar?: boolean;
}) {
  return <div class={styles.search} data-inset={props.inset ? '' : undefined} data-toolbar-field={props.toolbar ? '' : undefined}>
    <SearchField
      value={props.search.value()}
      placeholder={props.placeholder ?? t('library.filterCollection')}
      onInput={props.search.setValue}
      onKeyDown={event => {
        if (event.key !== 'Escape' || event.isComposing || !props.search.value()) return;
        event.preventDefault();
        event.stopPropagation();
        props.search.setValue('');
      }}
    />
  </div>;
}

export function NoCollectionMatches() {
  return <EmptyState compact>{t('library.noCollectionMatches')}</EmptyState>;
}
