import { createMemo, createSignal, Show, type Accessor, type JSX } from 'solid-js';
import { t } from '../lib/i18n';
import { filterLocalCollection, normalizeLibraryQuery, type SearchFieldValue } from '../lib/librarySearch';
import { EmptyState } from './EmptyState';
import { SearchField } from './SearchField';
import { PageToolbar } from './PageToolbar';

/** Filters available rows in place. The source array still owns their order and identity. */
export function createCollectionSearch() {
  const [value, setValue] = createSignal('');
  const query = createMemo(() => normalizeLibraryQuery(value()));

  function filter<T>(items: Accessor<T[]>, fields: (item: T) => SearchFieldValue[]) {
    return createMemo(() => filterLocalCollection(items(), query(), fields));
  }

  /** A row's 1-based place in the unfiltered list, for numbers that mean a
   * track position or a rank and must not change while filtering. Keyed by
   * item, so a list that repeats an item gets its last place for every copy:
   * use it only on lists without repeats (album and artist tracks). */
  function positions<T>(items: Accessor<T[]>) {
    const map = createMemo(() => new Map(items().map((item, index) => [item, index + 1])));
    return (item: T) => map().get(item) ?? 0;
  }

  return { value, setValue, query, filter, positions };
}

type CollectionSearchProps = {
  search: Pick<ReturnType<typeof createCollectionSearch>, 'value' | 'setValue'>;
  placeholder?: string;
};

export function CollectionSearch(props: CollectionSearchProps) {
  return <SearchField
    value={props.search.value()}
    placeholder={props.placeholder ?? t('library.filterCollection')}
    onInput={props.search.setValue}
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.isComposing || !props.search.value()) return;
      event.preventDefault();
      event.stopPropagation();
      props.search.setValue('');
    }}
  />;
}

export function CollectionToolbar(props: CollectionSearchProps & {
  contained?: boolean;
  actions?: JSX.Element;
  meta?: JSX.Element;
}) {
  return <PageToolbar contained={props.contained} field={<CollectionSearch search={props.search} placeholder={props.placeholder} />}
    meta={props.meta} actions={props.actions} />;
}

export function NoCollectionMatches() {
  return <EmptyState compact>{t('library.noCollectionMatches')}</EmptyState>;
}

/** For a filtered list that came out empty: "no matches" when the unfiltered
 * source has rows (so a query hid them all), otherwise the view's own empty
 * state. A filter returns the source whole without a query, so the source's
 * size alone tells the two apart. */
export function CollectionEmpty(props: { source: number; children: JSX.Element }) {
  return <Show when={props.source > 0} fallback={props.children}><NoCollectionMatches /></Show>;
}
