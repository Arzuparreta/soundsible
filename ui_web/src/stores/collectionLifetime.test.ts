import { expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { createCollection } from './collection';
import { RuntimeLifetime } from '../lib/runtimeLifetime';
import { state, setState, resetAccountState } from './core';

vi.mock('../lib/api', () => ({ api: { updateTrackMetadata: vi.fn() } }));
vi.mock('../lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

it.each(['resolve', 'reject'])('an old metadata %s cannot update or roll back the next account', async outcome => {
  let complete!: () => void;
  vi.mocked(api.updateTrackMetadata).mockImplementation(() => new Promise<{ status?: string }> ((resolve, reject) => {
    complete = () => outcome === 'resolve' ? resolve({}) : reject(new Error('offline'));
  }));
  const lifetime = new RuntimeLifetime();
  const collection = createCollection({
    actions: { syncLibrary: vi.fn(), toggleFavourite: vi.fn(), toggleSaved: vi.fn() },
    removeTrackReferences: vi.fn(), restorePlaybackSnapshot: vi.fn(),
  }, lifetime);
  setState('library', [{ id: 'same', title: 'old', artist: 'old' }]);
  const edit = collection.actions.updateTrackMetadata('same', { title: 'pending' });
  lifetime.close();
  resetAccountState();
  setState('library', [{ id: 'same', title: 'new account', artist: 'new' }]);
  complete();
  expect(await edit).toBe(false);
  expect(state.library[0].title).toBe('new account');
  resetAccountState();
});
