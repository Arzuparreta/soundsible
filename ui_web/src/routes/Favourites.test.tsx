import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { For } from 'solid-js';
import { expect, it, vi } from 'vitest';
import type { Track } from '../types/music';
import Favourites from './Favourites';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), play: vi.fn() }));

vi.mock('@solidjs/router', () => ({ A: () => null }));
vi.mock('../lib/shellLayout', () => ({ desktopShell: () => true }));
vi.mock('../lib/api', () => ({ api: { resolveCatalogItem: mocks.resolve } }));
vi.mock('../stores/player', () => ({ player: () => ({ autoMode: { active: false }, actions: { playFrom: mocks.play } }) }));
const storeState = vi.hoisted(() => ({
  loading: false,
  rows: [
    { track: { id: 'already-owned', title: 'First track', artist: 'Another artist' }, entry: { id: 'already-owned' } },
    { track: { id: 'deezer:1', title: 'Café', artist: 'Artist', source: 'preview' }, entry: { keys: ['deezer:1'], title: 'Café', artist: 'Artist' } },
  ],
}));

vi.mock('../stores', () => ({
  get state() { return { loading: storeState.loading }; },
  favouriteRows: () => storeState.rows,
}));
vi.mock('../components/CollectionActions', () => ({ CollectionActions: () => null }));
vi.mock('../components/TrackList', () => ({
  default: (props: { tracks: Track[]; onPlay: (tracks: Track[], index: number) => void }) =>
    <For each={props.tracks}>{(track, index) =>
      <button onClick={() => props.onPlay(props.tracks, index())}>{track.title}</button>
    }</For>,
}));

it('resolves the selected favourite by the filtered row and preserves its playback context', async () => {
  mocks.resolve.mockResolvedValue({ video_id: 'resolved-video' });
  render(() => <Favourites />);
  fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'cafe' } });
  expect(screen.queryByRole('button', { name: 'First track' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Café' }));

  expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ title: 'Café', artist: 'Artist' }));
  await waitFor(() => expect(mocks.play).toHaveBeenCalledWith(
    [expect.objectContaining({ id: 'resolved-video', title: 'Café' })], 0,
    { context: expect.objectContaining({ kind: 'favourites', destination: '/favourites' }) },
  ));
});

it('reserves the desktop toolbar skeleton without a live searchbox while favourites are loading', () => {
  const savedRows = storeState.rows;
  storeState.loading = true;
  storeState.rows = [];
  let unmount: (() => void) | undefined;
  try {
    const rendered = render(() => <Favourites />);
    unmount = rendered.unmount;
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(rendered.container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
  } finally {
    unmount?.();
    storeState.loading = false;
    storeState.rows = savedRows;
  }
});
