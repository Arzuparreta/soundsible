import { createEffect, on, onCleanup } from 'solid-js';
import { ViewHeader } from '../components/ViewHeader';
import { createCollectionSearch } from '../components/CollectionSearch';
import { matchesSavedEntity } from '../lib/librarySearch';
import { savedEntities, type SavedEntity } from '../lib/savedEntities';

export default function BookmarkHeader(props: {
  title: string;
  kind?: SavedEntity['kind'];
  onMatchChange: (match?: (entry: SavedEntity) => boolean) => void;
}) {
  const search = createCollectionSearch();
  createEffect(on(() => props.kind, search.reset, { defer: true }));
  createEffect(() => {
    const query = search.query();
    props.onMatchChange(query ? entry => matchesSavedEntity(entry, query) : undefined);
  });
  onCleanup(() => props.onMatchChange());
  const canSearch = () => savedEntities().some(entry => !props.kind || entry.kind === props.kind);
  return <ViewHeader title={props.title} search={canSearch() ? search.reveal : undefined} />;
}
