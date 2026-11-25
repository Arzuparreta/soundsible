import { createMemo, createSignal, Show, type Accessor, type JSX } from 'solid-js';
import { t } from '../lib/i18n';
import { filterLocalCollection, normalizeLibraryQuery, type SearchFieldValue } from '../lib/librarySearch';
import { EmptyState } from './EmptyState';
import { createSearchReveal } from './SearchReveal';
import { collectionSearchField } from './collectionSearchField';

/** Filters available rows in place. The source array still owns their order and identity. */
export function createCollectionSearch(placeholder?: Accessor<string>) {
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

  const reveal = createSearchReveal(() => collectionSearchField(value, setValue, placeholder?.()));
  const reset = () => { setValue(''); reveal.reset(); };
  return { value, setValue, query, filter, positions, reveal, reset };
}

export type CollectionSearchState = ReturnType<typeof createCollectionSearch>;

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
