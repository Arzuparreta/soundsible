import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { setLocale } from '../lib/i18n';
import { SearchDiscoveryView } from './SearchDiscoveryView';
import { formatDiscoveryReleaseDate, isColdDiscoveryFeed, resolveDiscoveryTrackShelves, type DiscoveryTrackShelf } from '../lib/searchDiscovery';
import type { CatalogItem } from '../types/music';
import type { DiscoveryBrowseSection } from '../lib/api';
afterEach(cleanup);
const songs: CatalogItem[] = Array.from({ length: 10 }, (_, index) => ({ id: `song:${index}`, title: `Song ${index}`, source: 'library', type: 'library_track' }));
const flatSongsShelf = (items: CatalogItem[]): DiscoveryTrackShelf[] => items.length ? [{ id: 'songs', title: '', titleKey: 'songs', items }] : [];
it('keeps songs bounded on home and delegates section, entity and playback actions independently', () => {
  setLocale('en');
  const [expanded, setExpanded] = createSignal<string | undefined>();
  const openEntity = vi.fn(), play = vi.fn(), back = vi.fn();
  const view = render(() => <SearchDiscoveryView sections={[{ id: 'artists', popular: false, items: [{ id: 'artist:1', title: 'Artist', type: 'artist', source: 'deezer' }] }]}
    trackShelves={flatSongsShelf(songs)} expanded={expanded()} loading={false} error={false} preparing={false} onBack={back} onRetry={vi.fn()}
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
  const view = render(() => <SearchDiscoveryView sections={[]} trackShelves={flatSongsShelf([songs[0]])} loading={false} error preparing={false}
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
  return render(() => <SearchDiscoveryView sections={[emptyArtists, albums]} trackShelves={[]} expanded={props.expanded}
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
  const view = render(() => <SearchDiscoveryView sections={[section]} trackShelves={[]} expanded={expanded()}
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

it('renders localized structured track shelves with reasons and expands dynamic shelves', async () => {
  await setLocale('en');
  const shelves = resolveDiscoveryTrackShelves({
    sections: [
      {
        id: 'because_you_listen_extremoduro',
        title: 'More like Extremoduro',
        title_key: 'more_like',
        title_params: { artist: 'Extremoduro' },
        reason: 'Fallback text',
        reason_key: 'because_listen',
        reason_params: { artist: 'Extremoduro' },
        item_ids: Array.from({ length: 7 }, (_, i) => `rel:${i}`),
      },
      {
        id: 'explore_from_seed',
        title: 'Explore from Seed',
        title_key: 'explore_from',
        title_params: { title: 'Jesucristo García' },
        reason_key: 'explore_connections',
        item_ids: ['rel:0', 'graph:1'],
      },
      {
        id: 'rediscover',
        title: 'Rediscover',
        title_key: 'rediscover',
        reason_key: 'rediscover',
        item_ids: ['lib:1'],
      },
      {
        id: 'from_playlist_road',
        title: 'Road Trip',
        title_key: 'from_playlist',
        title_params: { playlist: 'Road Trip' },
        reason_key: 'from_playlist',
        item_ids: ['lib:2'],
      },
      {
        id: 'custom_shelf',
        title: 'Custom Picks',
        reason: 'Curated locally.',
        item_ids: ['lib:3'],
      },
    ],
    items: [
      ...Array.from({ length: 7 }, (_, i) => ({ id: `rel:${i}`, title: `Related ${i}`, artist: `Band ${i}` })),
      { id: 'graph:1', title: 'Graph Track', artist: 'Graph Band' },
      { id: 'lib:1', track_id: 't1', title: 'Old Gem', artist: 'Archive' },
      { id: 'lib:2', track_id: 't2', title: 'Playlist Track', artist: 'Road Band' },
      { id: 'lib:3', track_id: 't3', title: 'Custom Track', artist: 'Custom Band' },
    ],
  }, items => [...items]);

  const [expanded, setExpanded] = createSignal<string | undefined>();
  const view = render(() => <SearchDiscoveryView sections={[]} trackShelves={shelves} expanded={expanded()}
    loading={false} error={false} preparing={false} onBack={() => setExpanded(undefined)} onRetry={vi.fn()}
    renderMore={(id, link) => <button aria-label={link.label} onClick={() => setExpanded(id)}>{link.children}</button>}
    renderEntity={noop} renderStatus={noop}
    renderSong={item => <button>{item.title}</button>} />);

  expect(view.getByRole('region', { name: 'More like Extremoduro' })).toBeTruthy();
  expect(view.getByText('Similar artists based on your listening')).toBeTruthy();
  expect(view.getByRole('region', { name: 'Explore from Jesucristo García' })).toBeTruthy();
  expect(view.getByText('Connections from your listening graph')).toBeTruthy();
  expect(view.getByRole('region', { name: 'Rediscover' })).toBeTruthy();
  expect(view.getByText("Tracks from your library you haven't played lately")).toBeTruthy();
  expect(view.getByRole('region', { name: 'From Road Trip' })).toBeTruthy();
  expect(view.getByText('Tracks from your playlist')).toBeTruthy();
  expect(view.getByRole('region', { name: 'Custom Picks' })).toBeTruthy();
  expect(view.getByText('Curated locally.')).toBeTruthy();

  expect(view.queryByRole('button', { name: 'Related 6' })).toBeNull();
  const more = view.getByRole('button', { name: 'See all: More like Extremoduro' });
  more.focus();
  fireEvent.click(more);

  await waitFor(() => expect(view.getByRole('heading', { name: 'More like Extremoduro' })).toHaveFocus());
  expect(view.getByRole('button', { name: 'Related 6' })).toBeTruthy();
  expect(view.queryByRole('region', { name: 'Rediscover' })).toBeNull();

  await setLocale('es');
  await waitFor(() => expect(view.getByRole('heading', { name: 'Más como Extremoduro' })).toBeTruthy());
  expect(view.getByText('Artistas similares según lo que escuchas')).toBeTruthy();

  fireEvent.click(view.getByRole('button', { name: 'Volver a Descubrir' }));
  await waitFor(() => expect(view.getByRole('button', { name: 'Ver todos: Más como Extremoduro' })).toHaveFocus());
  await setLocale('en');
});

it('shows entity reason attribution while omitting empty or self-redundant reasons', async () => {
  await setLocale('en');
  const browse: DiscoveryBrowseSection[] = [
    {
      id: 'artists',
      popular: false,
      items: [
        { id: 'artist:1', title: 'Marea', type: 'artist', source: 'deezer', reason_artist: 'Extremoduro' },
        { id: 'artist:2', title: 'Extremoduro', type: 'artist', source: 'deezer', reason_artist: 'Extremoduro' },
        { id: 'artist:3', title: 'Robe', type: 'artist', source: 'deezer', reason_artist: '' },
      ],
    },
    {
      id: 'albums',
      popular: false,
      items: [
        { id: 'album:1', title: 'Besos de perro', artist: 'Marea', type: 'album', source: 'deezer', reason_artist: 'Extremoduro' },
        { id: 'album:2', title: 'Agila', artist: 'Extremoduro', type: 'album', source: 'deezer', reason_artist: 'Extremoduro' },
      ],
    },
  ];
  const view = render(() => <SearchDiscoveryView sections={browse} trackShelves={[]}
    loading={false} error={false} preparing={false} onBack={vi.fn()} onRetry={vi.fn()}
    renderMore={noop} renderEntity={(_, link) => <button class={link.class} aria-label={link.label}>{link.children}</button>}
    renderStatus={noop} renderSong={noop} />);

  expect(view.getAllByText('Similar to Extremoduro')).toHaveLength(2);
});

it('formats single and ep subtitles locally without rendering an inline refresh row above shelves', async () => {
  await setLocale('en');
  const browse: DiscoveryBrowseSection[] = [
    {
      id: 'albums',
      popular: false,
      items: [
        { id: 'album:1', title: 'Single Cut', artist: 'Marea', type: 'album', source: 'deezer', record_type: 'single' },
        { id: 'album:2', title: 'Mini EP', artist: 'Extremoduro', type: 'album', source: 'deezer', record_type: 'ep' },
      ],
    },
  ];
  const view = render(() => <SearchDiscoveryView sections={browse} trackShelves={[]} expanded={undefined}
    loading={false} error={false} preparing={false}
    onBack={vi.fn()} onRetry={vi.fn()} renderMore={noop}
    renderEntity={(_, link) => <button class={link.class} aria-label={link.label}>{link.children}</button>}
    renderStatus={noop} renderSong={noop} />);

  expect(view.getByText('Marea · Single')).toBeTruthy();
  expect(view.getByText('Extremoduro · EP')).toBeTruthy();
  expect(view.queryByRole('button', { name: /Refresh|Actualizar/ })).toBeNull();

  await setLocale('es');
  expect(view.getByText('Marea · Sencillo')).toBeTruthy();
  await setLocale('en');
});

it('renders new_releases with New badge, localized release dates, expansion, and focus restoration', async () => {
  await setLocale('en');
  const now = new Date(Date.UTC(2026, 10, 22));
  expect(formatDiscoveryReleaseDate('2026-11-18', now)).toBeTruthy();
  expect(formatDiscoveryReleaseDate('2025-12-10', now)).toContain('2025');
  expect(formatDiscoveryReleaseDate('2026-02-31', now)).toBe('');

  const [expanded, setExpanded] = createSignal<string | undefined>();
  const browse: DiscoveryBrowseSection[] = [
    {
      id: 'new_releases',
      popular: false,
      items: [
        { id: 'album:1', title: 'Fresh EP', artist: 'Marea', type: 'album', source: 'deezer', record_type: 'ep', release_date: '2026-11-18', is_new: true },
        { id: 'album:2', title: 'Season Single', artist: 'Robe', type: 'album', source: 'deezer', record_type: 'single', release_date: '2026-09-10', is_new: false },
        { id: 'album:3', title: 'Latest LP', artist: 'Extremoduro', type: 'album', source: 'deezer', record_type: 'album', release_date: '2026-08-05', is_new: false },
      ],
    },
    {
      id: 'artists',
      popular: false,
      items: [{ id: 'artist:1', title: 'Platero y Tú', type: 'artist', source: 'deezer' }],
    },
  ];

  const view = render(() => <SearchDiscoveryView sections={browse} trackShelves={[]} expanded={expanded()}
    loading={false} error={false} preparing={false} onBack={() => setExpanded(undefined)} onRetry={vi.fn()}
    renderMore={(id, link) => <button aria-label={link.label} onClick={() => setExpanded(id)}>{link.children}</button>}
    renderEntity={(_, link) => <button class={link.class} aria-label={link.label}>{link.children}</button>}
    renderStatus={noop} renderSong={noop} />);

  const region = view.getByRole('region', { name: 'New releases' });
  expect(region).toBeTruthy();
  expect(view.getAllByText('New')).toHaveLength(1);
  expect(view.getByText(`Marea · EP · ${formatDiscoveryReleaseDate('2026-11-18')}`)).toBeTruthy();
  expect(view.getByText(`Robe · Single · ${formatDiscoveryReleaseDate('2026-09-10')}`)).toBeTruthy();
  expect(view.getByText(`Extremoduro · ${formatDiscoveryReleaseDate('2026-08-05')}`)).toBeTruthy();

  await setLocale('es');
  await waitFor(() => expect(view.getByRole('region', { name: 'Novedades' })).toBeTruthy());
  expect(view.getByText('Nuevo')).toBeTruthy();
  await setLocale('en');

  const more = view.getByRole('button', { name: 'See all: New releases' });
  more.focus();
  fireEvent.click(more);
  await waitFor(() => expect(view.getByRole('heading', { name: 'New releases' })).toHaveFocus());
  expect(view.queryByRole('region', { name: 'Artists to discover' })).toBeNull();

  fireEvent.click(view.getByRole('button', { name: 'Back to Discover' }));
  await waitFor(() => expect(view.getByRole('button', { name: 'See all: New releases' })).toHaveFocus());
});

it('shows the passive cold-start hint only on an unexpanded cold popular feed', async () => {
  await setLocale('en');
  const popularSections: DiscoveryBrowseSection[] = [
    { id: 'artists', popular: true, items: [{ id: 'artist:1', title: 'Popular', type: 'artist', source: 'deezer' }] },
  ];
  expect(isColdDiscoveryFeed({ needs_seed: true }, popularSections, [])).toBe(true);
  expect(isColdDiscoveryFeed({ needs_seed: false }, popularSections, [])).toBe(false);

  const [cold, setCold] = createSignal(true);
  const [expanded, setExpanded] = createSignal<string | undefined>();
  const [preparing, setPreparing] = createSignal(false);
  const view = render(() => <SearchDiscoveryView sections={popularSections} trackShelves={[]} expanded={expanded()}
    loading={false} error={false} preparing={preparing()} cold={cold()} onBack={vi.fn()} onRetry={vi.fn()}
    renderMore={noop} renderEntity={(_, link) => <button class={link.class}>{link.children}</button>}
    renderStatus={noop} renderSong={noop} />);

  expect(view.getByRole('note')).toHaveTextContent('Discover adapts automatically');
  setExpanded('artists');
  expect(view.queryByRole('note')).toBeNull();
  setExpanded(undefined);
  setPreparing(true);
  expect(view.queryByRole('note')).toBeNull();
  setPreparing(false);
  setCold(false);
  expect(view.queryByRole('note')).toBeNull();
});
