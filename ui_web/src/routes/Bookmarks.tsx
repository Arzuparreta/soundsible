import { createEffect, createMemo, on } from 'solid-js';
import { ViewHeader } from '../components/ViewHeader';
import { createCollectionSearch } from '../components/CollectionSearch';
import SavedEntities from '../components/SavedEntities';
import { MusicLink } from '../components/MusicLinks';
import { matchesSavedEntity } from '../lib/librarySearch';
import { savedEntities, type SavedEntity } from '../lib/savedEntities';
import { registerPrimaryScroll } from '../lib/scrollHistory';
import { reselectPrimaryTab } from '../lib/tabNavigation';
import { t } from '../lib/i18n';
import styles from './Bookmarks.module.css';

/** Dedicated route for bookmarked artists and albums, optionally filtered by kind. */
export default function Bookmarks(props: { kind?: SavedEntity['kind'] }) {
  const search = createCollectionSearch();
  createEffect(on(() => props.kind, search.reset, { defer: true }));
  const match = createMemo(() => {
    const query = search.query();
    return query ? (entry: SavedEntity) => matchesSavedEntity(entry, query) : undefined;
  });
  const canSearch = () => savedEntities().some(entry => !props.kind || entry.kind === props.kind);
  const title = () => props.kind === 'album'
    ? t('savedEntities.albums')
    : props.kind === 'artist' ? t('savedEntities.artists') : t('savedEntities.title');
  return (
    <div class="view">
      <ViewHeader
        title={title()}
        search={canSearch() ? search.reveal : undefined}
        onTitleTap={() => reselectPrimaryTab('/bookmarks')}
      />
      <div class={styles.body} ref={element => registerPrimaryScroll(element)} data-primary-scroll>
        <MusicLink class={styles.back} path="/">← {t('savedEntities.back')}</MusicLink>
        <SavedEntities kind={props.kind} expanded match={match()} />
      </div>
    </div>
  );
}
