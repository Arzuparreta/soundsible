import { beforeEach, expect, it, vi } from 'vitest';

const { setEntitySaved, isEntitySaved } = vi.hoisted(() => ({
  setEntitySaved: vi.fn(),
  isEntitySaved: vi.fn(() => false),
}));
vi.mock('../lib/savedEntities', () => ({
  setEntitySaved, isEntitySaved, entitiesBusy: () => false, syncSavedEntities: vi.fn(),
}));
vi.mock('../lib/catalogCollection', () => ({ catalogSavedEntity: vi.fn() }));
vi.mock('../lib/contextMenu', () => ({ openContextMenu: vi.fn() }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));

import { savedEntityAction } from './savedEntityActions';

beforeEach(() => vi.clearAllMocks());

it.each(['artist', 'album'] as const)('card and saved-row actions only toggle the %s bookmark', (kind) => {
  const entry = { kind, name: 'Discovery', destination: `/${kind}/Discovery?deezer_id=27` };
  isEntitySaved.mockReturnValue(false);
  const action = savedEntityAction(entry);
  expect(action.label).toBe('savedEntities.save');
  action.onSelect();
  expect(setEntitySaved).toHaveBeenLastCalledWith(entry, true);

  isEntitySaved.mockReturnValue(true);
  expect(action.label).toBe('savedEntities.remove');
  action.onSelect();
  expect(setEntitySaved).toHaveBeenLastCalledWith(entry, false);
});
