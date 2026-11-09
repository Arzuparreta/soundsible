import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { setLocale } from '../lib/i18n';
import { SearchDiscoveryView } from './SearchDiscoveryView';
import type { CatalogItem } from '../types/music';
import type { DiscoveryBrowseSection } from '../lib/api';
afterEach(cleanup);
const songs: CatalogItem[] = Array.from({ length: 10 }, (_, index) => ({ id: `song:${index}`, title: `Song ${index}`, source: 'library', type: 'library_track' }));
it('keeps songs bounded on home and delegates section, entity and playback actions independently', () => {
  setLocale('en');
  const [expanded, setExpanded] = createSignal<string | undefined>();
  const openEntity = vi.fn(), play = vi.fn(), back = vi.fn();
  const view = render(() => <SearchDiscoveryView sections={[{ id: 'artists', popular: false, items: [{ id: 'artist:1', title: 'Artist', type: 'artist', source: 'deezer' }] }]}
    songs={songs} expanded={expanded()} loading={false} error={false} preparing={false} onBack={back} onRetry={vi.fn()}
    renderMore={(section, link) => <button aria-label={link.label} onClick={() => setExpanded(section)}>{link.children}</button>}
    renderEntity={(item, link) => <button aria-label={link.label} onClick={() => openEntity(item)}>{link.children}</button>}
    renderStatus={() => null} renderSong={item => <button onClick={() => play(item)}>{item.title}</button>} />);
  expect(view.queryByRole('button', { name: 'Song 5' })).toBeNull();
  fireEvent.click(view.getByRole('button', { name: 'Artist' }));
  expect(openEntity).toHaveBeenCalledTimes(1); expect(play).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole('button', { name: /See all:.*songs/i }));
  expect(view.getByRole('button', { name: 'Song 9' })).toBeTruthy();
  expect(view.queryByRole('button', { name: 'Artist' })).toBeNull();
  fireEvent.click(view.getByRole('button', { name: 'Song 9' })); expect(play).toHaveBeenCalledWith(songs[9]);
  fireEvent.click(view.getByRole('button', { name: /Back/ })); expect(back).toHaveBeenCalledOnce();
});
it('keeps partial content visible and delegates retry without pretending that playback succeeded', () => {
  setLocale('en'); const retry = vi.fn();
  const view = render(() => <SearchDiscoveryView sections={[]} songs={[songs[0]]} loading={false} error preparing={false}
    onBack={vi.fn()} onRetry={retry} renderMore={() => null} renderEntity={() => null} renderStatus={() => null}
    renderSong={item => <span>{item.title}</span>} />);
  expect(view.getByText('Song 0')).toBeTruthy();
  fireEvent.click(view.getByRole('button', { name: 'Retry' })); expect(retry).toHaveBeenCalledOnce();
  expect(view.container.querySelector('audio')).toBeNull();
});
const noop = () => null;
const albums: DiscoveryBrowseSection = { id: 'albums', popular: false, items: [{ id: 'album:1', title: 'Album', type: 'album', source: 'deezer', artist: 'Band' }] };
const emptyArtists: DiscoveryBrowseSection = { id: 'artists', popular: false, items: [] };
function renderView(props: { expanded?: string; loading?: boolean; preparing?: boolean; error?: boolean }) {
  return render(() => <SearchDiscoveryView sections={[emptyArtists, albums]} songs={[]} expanded={props.expanded}
    loading={!!props.loading} error={!!props.error} preparing={!!props.preparing} onBack={vi.fn()} onRetry={vi.fn()}
    renderMore={noop} renderEntity={(_, link) => <button class={link.class} aria-label={link.label}>{link.children}</button>}
    renderStatus={noop} renderSong={noop} />);
}
it('judges an opened section by its own items, not by the rest of the feed', () => {
  setLocale('en');
  // Albums exist, artists do not: the artists page used to be blank.
  const view = renderView({ expanded: 'artists' });
  expect(view.getByText('Nothing to show in this section yet.')).toBeTruthy();
  expect(view.queryByRole('button', { name: 'Album' })).toBeNull();
  cleanup();
  const loading = renderView({ expanded: 'artists', loading: true });
  expect(loading.container.querySelector('[data-shape="round"]')).toBeTruthy();
  cleanup();
  expect(renderView({ expanded: 'artists', preparing: true }).getByText('Finding artists and albums for you…')).toBeTruthy();
});
it('names each section by its heading and never draws an empty one', () => {
  setLocale('en');
  const view = renderView({});
  expect(view.getByRole('region', { name: 'Albums for you' })).toBeTruthy();
  expect(view.queryByRole('heading', { name: 'Artists to discover' })).toBeNull();
  expect(view.queryByText('Search for music to start exploring.')).toBeNull();
});

it('keeps focus on the expanded heading and returns it to the same See all link', async () => {
  setLocale('en');
  const [expanded, setExpanded] = createSignal<string | undefined>();
  const section = { ...albums, items: Array.from({ length: 3 }, (_, i) => ({ ...albums.items[0], id: `album:${i}` })) };
  const view = render(() => <SearchDiscoveryView sections={[section]} songs={[]} expanded={expanded()}
    loading={false} error={false} preparing={false} onBack={() => setExpanded(undefined)} onRetry={vi.fn()}
    renderMore={(id, link) => <button aria-label={link.label} onClick={() => setExpanded(id)}>{link.children}</button>}
    renderEntity={noop} renderStatus={noop} renderSong={noop} />);
  const more = view.getByRole('button', { name: 'See all: Albums for you' });
  more.focus();
  fireEvent.click(more);
  await waitFor(() => expect(view.getByRole('heading', { name: 'Albums for you' })).toHaveFocus());
  fireEvent.click(view.getByRole('button', { name: 'Back to Discover' }));
  await waitFor(() => expect(view.getByRole('button', { name: 'See all: Albums for you' })).toHaveFocus());
});
