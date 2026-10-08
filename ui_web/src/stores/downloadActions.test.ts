import { describe, expect, it, vi } from 'vitest';
import type { RuntimeLifetime } from '../lib/runtimeLifetime';
import type { SavedEntry } from '../types/music';

vi.mock('../lib/api', () => ({ api: { resolveCatalogItem: vi.fn(), enqueueDownload: vi.fn(), emitDiscoveryEvent: vi.fn() } }));
vi.mock('../lib/toast', () => ({ toast: { info: vi.fn(), error: vi.fn(), loading: () => ({ update: vi.fn(), dismiss: vi.fn() }) } }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
vi.mock('./core', () => ({ state: { library: [], downloads: { queue: [] } }, setState: vi.fn() }));

import { createDownloadActions } from './downloadActions';

const lifetime = { capture: () => () => true, guard: <T>(fn: T) => fn } as unknown as RuntimeLifetime;

describe('downloading a saved song', () => {
  it('files it under the record it was saved from', async () => {
    const downloadTrack = vi.fn().mockResolvedValue(undefined);
    const { actions } = createDownloadActions({ actions: { downloadTrack, loadDownloads: vi.fn() } }, lifetime);
    const entry: SavedEntry = {
      keys: ['yt:A1111111111', 'cat:deezer:track:1'], title: 'Song', artist: 'Artist', album: 'Album',
      album_artist: 'Artist', track_number: 3, disc_number: 2, year: 2001,
    };
    await actions.downloadSaved(entry);
    expect(downloadTrack).toHaveBeenCalledWith(expect.objectContaining({
      id: 'A1111111111', source: 'preview', album: 'Album', album_artist: 'Artist', track_number: 3, disc_number: 2, year: 2001,
    }), 'library');
  });
});
