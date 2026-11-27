import { onMount } from 'solid-js';
import { entitiesError, entitiesLoading, savedEntities, syncSavedEntities } from '../lib/savedEntities';
import { openSavedEntityMenu } from './savedEntityActions';
import { SavedEntityList, type SavedEntitiesProps } from './SavedEntityList';

/** Pinned artist and album bookmarks, shown on Home and on the Bookmarks routes. */
export default function SavedEntities(props: SavedEntitiesProps) {
  onMount(() => void syncSavedEntities());
  return <SavedEntityList {...props} entries={savedEntities()} loading={entitiesLoading()}
    failed={entitiesError()} retry={syncSavedEntities} onMenu={openSavedEntityMenu} />;
}
