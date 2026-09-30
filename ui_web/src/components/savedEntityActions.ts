import type { CatalogItem } from '../types/music';
import { catalogSavedEntity } from '../lib/catalogCollection';
import { openContextMenu } from '../lib/contextMenu';
import { entitiesBusy, isEntitySaved, setEntitySaved, syncSavedEntities, type SavedEntity } from '../lib/savedEntities';
import { t } from '../lib/i18n';
import { menuIcons } from './icons';
import type { MenuAction } from './ActionMenu';

export function savedEntityAction(entry: SavedEntity): MenuAction {
  return {
    get icon() { return isEntitySaved(entry) ? menuIcons.unbookmark() : menuIcons.bookmark(); },
    get label() { return t(isEntitySaved(entry) ? 'savedEntities.remove' : 'savedEntities.save'); },
    get danger() { return isEntitySaved(entry); },
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
