import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogItem, Track } from '../types/music';

const mock = vi.hoisted(() => ({
  autoActive: false,
  remote: false,
  current: null as Track | null,
  actions: {
    playFrom: vi.fn(),
    playShuffled: vi.fn(),
    startDjSelection: vi.fn(() => true),
    enterAutoMode: vi.fn(() => { mock.autoActive = true; }),
    addAutoSource: vi.fn(),
    changeAutoSession: vi.fn().mockResolvedValue(true),
  },
  catalog: {
    playCatalogItem: vi.fn(),
    useCatalogCollection: vi.fn().mockResolvedValue(true),
    itemToTrack: vi.fn(() => null),
    resolveCatalogTrack: vi.fn(),
    itemArtist: (item: { artist?: string }) => item.artist ?? '',
  },
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

vi.mock('../stores/player', () => ({
  player: () => ({ actions: mock.actions, autoMode: { active: mock.autoActive }, playback: { currentTrack: mock.current }, remote: mock.remote }),
}));
vi.mock('../lib/catalogItem', () => mock.catalog);
vi.mock('../lib/toast', () => ({ toast: mock.toast }));
vi.mock('../lib/api', () => ({ api: {} }));
vi.mock('../lib/musicNavigation', () => ({ catalogDestination: () => '/artist/A' }));
vi.mock('../lib/contextMenu', () => ({ openContextMenu: vi.fn() }));

import { setLocale } from '../lib/i18n';
import { collectionActions, playCollection, startDjFromCollection, useCollectionInSession, type MusicCollection } from './collectionCommands';

const songs: Track[] = [{ id: 's1', title: 'One', artist: 'A' }, { id: 's2', title: 'Two', artist: 'A' }];
const context = { id: 'album:Record', kind: 'album', label: 'Record' } as const;
const library: MusicCollection = { title: 'Record', context, songs: () => ({ tracks: songs }) };
const rows = [{ id: 'deezer:1', type: 'track', title: 'One', artist: 'A' }] as unknown as CatalogItem[];
const catalog: MusicCollection = { title: 'Record', context, songs: async () => ({ items: rows }) };

beforeEach(() => {
  setLocale('en');
  vi.clearAllMocks();
  mock.autoActive = false;
  mock.remote = false;
  mock.current = null;
});

describe('collectionActions', () => {
  it('offers play, shuffle and a DJ start in NORMAL, and edits the session only inside the player', () => {
    expect(collectionActions(library).map((action) => action.label)).toEqual(['Play', 'Shuffle play', 'Start a DJ session']);
    mock.autoActive = true;
    // Outside the player a collection starts a new session; only inside it
    // does it change the one playing.
    expect(collectionActions(library).map((action) => action.label)).toEqual(['Start a DJ session']);
    expect(collectionActions(library, { shell: true }).map((action) => action.label)).toEqual(['Start a DJ session', 'Mix into session', 'Change session']);
  });
});

describe('starting DJ from a collection', () => {
  it('enters DJ on the first song and opens the session on the collection, from NORMAL', async () => {
    await startDjFromCollection(library);
    expect(mock.actions.enterAutoMode).toHaveBeenCalledWith({ source: songs[0], deferPlanning: true });
    expect(mock.actions.startDjSelection).toHaveBeenCalledWith(songs, 'Record');
  });

  it('refuses over a podcast before matching anything', async () => {
    mock.current = { id: 'ep', title: 'Episode', artist: 'Show', media_kind: 'podcast_episode' } as Track;
    await startDjFromCollection(catalog);
    expect(mock.toast.info).toHaveBeenCalled();
    expect(mock.catalog.resolveCatalogTrack).not.toHaveBeenCalled();
    expect(mock.actions.enterAutoMode).not.toHaveBeenCalled();
  });

  it('matches the first catalog song, then hands the rest to the DJ', async () => {
    mock.catalog.resolveCatalogTrack.mockResolvedValue({ ...songs[0], id: 'vid', source: 'preview' });
    await startDjFromCollection(catalog);
    expect(mock.actions.enterAutoMode).toHaveBeenCalledWith(expect.objectContaining({ source: expect.objectContaining({ id: 'vid' }) }));
    expect(mock.catalog.useCatalogCollection).toHaveBeenCalledWith(
      [expect.objectContaining({ external_ids: expect.objectContaining({ youtube_id: 'vid' }) })], 'Record', 'start', undefined, expect.any(Function));
  });
});

describe('playing a collection', () => {
  it('plays library songs in order or shuffled, and catalog songs through the catalog path', async () => {
    await playCollection(library);
    expect(mock.actions.playFrom).toHaveBeenCalledWith(songs, 0, { context });
    await playCollection(library, true);
    expect(mock.actions.playShuffled).toHaveBeenCalledWith(songs, context);
    await playCollection(catalog);
    expect(mock.catalog.playCatalogItem).toHaveBeenCalledWith(rows[0], rows, context);
  });

  it('starts a new session from it during one, as the pages do', async () => {
    mock.autoActive = true;
    await playCollection(library);
    expect(mock.actions.startDjSelection).toHaveBeenCalledWith(songs, 'Record');
    expect(mock.actions.playFrom).not.toHaveBeenCalled();
  });

  it('mixes it into the session or changes the session to it', async () => {
    mock.autoActive = true;
    await useCollectionInSession(library, 'reference');
    expect(mock.actions.addAutoSource).toHaveBeenCalledWith(songs, 'Record');
    await useCollectionInSession(library, 'change');
    expect(mock.actions.changeAutoSession).toHaveBeenCalledWith(songs, 'Record');
    await useCollectionInSession(catalog, 'reference');
    expect(mock.catalog.useCatalogCollection).toHaveBeenCalledWith(rows, 'Record', 'reference');
  });
});
