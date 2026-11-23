import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogItem, Track } from '../types/music';

const mock = vi.hoisted(() => ({
  autoActive: false,
  token: 1,
  actions: {
    playTrack: vi.fn(),
    playFrom: vi.fn(),
    playShuffled: vi.fn(),
    startDjSelection: vi.fn(),
    enqueue: vi.fn(),
    placeAutoTrack: vi.fn(),
    useAutoTrackAsSource: vi.fn(),
    changeAutoSession: vi.fn().mockResolvedValue(true),
    addAutoSource: vi.fn(),
    autoSessionToken: vi.fn(() => mock.token),
    beginAutoSessionChange: vi.fn(() => ++mock.token),
  },
  catalog: {
    playCatalogItem: vi.fn().mockResolvedValue(undefined),
    resolveCatalogTrack: vi.fn(),
    catalogContextTrack: vi.fn(),
    reportSearchPlay: vi.fn(),
  },
  toastError: vi.fn(),
}));

vi.mock('../stores/player', () => ({
  player: () => ({ actions: mock.actions, autoMode: { active: mock.autoActive } }),
}));
vi.mock('../lib/catalogItem', () => mock.catalog);
vi.mock('../lib/toast', () => ({ toast: { error: mock.toastError } }));

import { pickSong, queueSong } from './playerSearchActions';

const track: Track = { id: 'song-1', title: 'Song', artist: 'Artist' };
const item = { id: 'deezer:1', type: 'track', title: 'Song', artist: 'Artist' } as unknown as CatalogItem;

beforeEach(() => {
  vi.clearAllMocks();
  mock.autoActive = false;
  mock.token = 1;
  mock.catalog.resolveCatalogTrack.mockResolvedValue(track);
});

describe('pickSong', () => {
  it('plays through the same transport action as every other list, in and out of a DJ session', async () => {
    await pickSong({ track });
    mock.autoActive = true;
    await pickSong({ track });
    // `playTrack` is what starts a new DJ session from the song during one.
    expect(mock.actions.playTrack).toHaveBeenNthCalledWith(1, track);
    expect(mock.actions.playTrack).toHaveBeenNthCalledWith(2, track);
    expect(mock.actions.placeAutoTrack).not.toHaveBeenCalled();
  });

  it('plays a catalog row through the shared catalog path and reports a search play', async () => {
    await pickSong({ item }, {}, true);
    expect(mock.catalog.reportSearchPlay).toHaveBeenCalledWith(item);
    expect(mock.catalog.playCatalogItem).toHaveBeenCalledWith(item);
  });

  it('does the open errand instead of playing', async () => {
    const onDone = vi.fn();
    await pickSong({ item }, { intent: 'route', beforeQueueId: 'q-7', onDone });
    expect(mock.actions.placeAutoTrack).toHaveBeenCalledWith(track, 'q-7');
    await pickSong({ track }, { intent: 'reference', onDone });
    expect(mock.actions.useAutoTrackAsSource).toHaveBeenCalledWith(track);
    await pickSong({ track }, { intent: 'change', onDone });
    expect(mock.actions.beginAutoSessionChange).toHaveBeenCalled();
    expect(mock.actions.changeAutoSession).toHaveBeenCalledWith([track], 'Song');
    expect(onDone).toHaveBeenCalledTimes(3);
    expect(mock.actions.playTrack).not.toHaveBeenCalled();
  });

  it('drops an errand whose session or panel moved on while the row was matched', async () => {
    mock.catalog.resolveCatalogTrack.mockImplementation(async () => { mock.token += 1; return track; });
    await pickSong({ item }, { intent: 'route' });
    mock.catalog.resolveCatalogTrack.mockResolvedValue(track);
    await pickSong({ item }, { intent: 'route', isCurrent: () => false });
    expect(mock.actions.placeAutoTrack).not.toHaveBeenCalled();
  });

  it('says so when a catalog row cannot be matched', async () => {
    mock.catalog.resolveCatalogTrack.mockResolvedValue(null);
    await pickSong({ item }, { intent: 'reference' });
    expect(mock.toastError).toHaveBeenCalled();
    expect(mock.actions.useAutoTrackAsSource).not.toHaveBeenCalled();
  });
});

describe('queueSong', () => {
  it('queues an unmatched catalog row as a placeholder outside a DJ session', async () => {
    const pending = { ...track, id: 'pending:deezer:1' };
    mock.catalog.catalogContextTrack.mockReturnValue(pending);
    await queueSong({ item });
    expect(mock.catalog.resolveCatalogTrack).not.toHaveBeenCalled();
    expect(mock.actions.enqueue).toHaveBeenCalledWith(pending);
  });

  it('matches the row first in a DJ session, where the route plans with the song', async () => {
    mock.autoActive = true;
    await queueSong({ item });
    expect(mock.catalog.resolveCatalogTrack).toHaveBeenCalledWith(item);
    expect(mock.actions.enqueue).toHaveBeenCalledWith(track);
  });
});
