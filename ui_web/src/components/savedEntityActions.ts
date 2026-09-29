import type { CatalogItem } from '../types/music';
import { catalogSavedEntity } from '../lib/catalogCollection';
import { openContextMenu } from '../lib/contextMenu';
import { entitiesBusy, isEntitySaved, setEntitySaved, syncSavedEntities, type SavedEntity } from '../lib/savedEntities';
import { t } from '../lib/i18n';
import { menuIcons } from './icons';
import type { MenuAction } from './ActionMenu';

export function savedEntityAction(entry: SavedEntity): MenuAction {
  return {
    icon: entry.kind === 'artist' ? menuIcons.artist() : menuIcons.album(),
    get label() { return t(isEntitySaved(entry) ? 'savedEntities.remove' : 'savedEntities.save'); },
    get disabled() { return entitiesBusy(); },
    onSelect: () => void setEntitySaved(entry, !isEntitySaved(entry)),
  };
}

export function openSavedEntityMenu(entry: SavedEntity, event?: MouseEvent): void {
  void syncSavedEntities();
  openContextMenu({ title: entry.name, actions: [savedEntityAction(entry)] }, event);
}

export function openCatalogEntityMenu(item: CatalogItem, event?: MouseEvent): void {
  const entry = catalogSavedEntity(item);
  if (entry) openSavedEntityMenu(entry, event);
}
