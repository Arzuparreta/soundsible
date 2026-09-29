import { onMount } from 'solid-js';
import { entitiesBusy, isEntitySaved, setEntitySaved, syncSavedEntities, type SavedEntity } from '../lib/savedEntities';
import { t } from '../lib/i18n';
import styles from './SavedEntities.module.css';

export default function SaveEntityButton(props: { entry: SavedEntity }) {
  onMount(() => void syncSavedEntities());
  return <button type="button" class={styles.save} aria-pressed={isEntitySaved(props.entry)}
    disabled={entitiesBusy()} onClick={() => void setEntitySaved(props.entry, !isEntitySaved(props.entry))}>
    {isEntitySaved(props.entry) ? t('savedEntities.saved') : t('savedEntities.save')}
  </button>;
}
