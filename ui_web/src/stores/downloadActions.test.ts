import { describe, expect, it, vi } from 'vitest';
import { RuntimeLifetime } from '../lib/runtimeLifetime';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import type { SavedEntry } from '../types/music';

vi.mock('../lib/api', () => ({ api: { resolveCatalogItem: vi.fn(), enqueueDownload: vi.fn(), clearFailedDownloads: vi.fn(), emitDiscoveryEvent: vi.fn() } }));
vi.mock('../lib/toast', () => ({ toast: { info: vi.fn(), error: vi.fn(), loading: () => ({ update: vi.fn(), dismiss: vi.fn() }) } }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
vi.mock('./core', () => ({ state: { library: [], downloads: { queue: [] } }, setState: vi.fn() }));

import { createDownloadActions } from './downloadActions';

describe('downloading a saved song', () => {
  it('files it under the record it was saved from', async () => {
    const downloadTrack = vi.fn().mockResolvedValue(undefined);
    const { actions } = createDownloadActions({ actions: { downloadTrack, loadDownloads: vi.fn() } }, new RuntimeLifetime());
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

describe('download queue changes', () => {
  it.each(['success', 'failure'])('ignores a late %s after the account changes', async outcome => {
    const lifetime = new RuntimeLifetime();
    const pending = Promise.withResolvers<{ status?: string }>();
    vi.mocked(api.clearFailedDownloads).mockReturnValueOnce(pending.promise);
    const loadDownloads = vi.fn();
    const { actions } = createDownloadActions({ actions: { downloadTrack: vi.fn(), loadDownloads } }, lifetime);

    const cleared = actions.clearFailedDownloads();
    lifetime.close();
    lifetime.start();
    if (outcome === 'success') pending.resolve({ status: 'ok' });
    else pending.reject(new Error('offline'));
    await cleared;

    expect(loadDownloads).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('reports a current failure and reloads the queue', async () => {
    vi.mocked(api.clearFailedDownloads).mockRejectedValueOnce(new Error('offline'));
    const loadDownloads = vi.fn();
    const { actions } = createDownloadActions({ actions: { downloadTrack: vi.fn(), loadDownloads } }, new RuntimeLifetime());
    await actions.clearFailedDownloads();
    expect(loadDownloads).toHaveBeenCalledOnce();
    expect(toast.error).toHaveBeenCalledWith('toast.downloadOperationFailed');
  });
});
