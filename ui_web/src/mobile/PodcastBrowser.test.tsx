import { beforeEach, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { setLocale } from '../lib/i18n';
import PodcastBrowser from './PodcastBrowser';
import { dispatchNavigationBack } from './backNavigation';
import type { Track } from '../types/music';
const mocks = vi.hoisted(() => ({ request: vi.fn(), menu: vi.fn() }));
vi.mock('../lib/http', () => ({ request: mocks.request }));
vi.mock('../lib/contextMenu', () => ({ openContextMenu: mocks.menu }));
const show = { id: 'feed', title: 'My show', rss_url: 'https://example.com/feed' };
const episode = { guid: 'episode', title: 'First episode', enclosure_url: 'https://example.com/episode.mp4' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { cleanup(); setLocale('en'); vi.clearAllMocks(); mocks.request.mockResolvedValue({ episodes: [episode] }); });
it('plays the acquired identity of a streamed enclosure through its callback', async () => {
  const acquired = { id: 'local-episode', title: episode.title, artist: show.title, media_kind: 'podcast_episode', podcast_enclosure_url: episode.enclosure_url } as Track;
  const play = vi.fn().mockResolvedValue(undefined);
  const view = render(() => <PodcastBrowser generation={1} subscriptions={[show]} acquired={[acquired]} onPlay={play} />);
  fireEvent.click(view.getByText(show.title)); await waitFor(() => expect(view.getByText(episode.title)).toBeTruthy());
  fireEvent.click(view.getByText(episode.title)); expect(play).toHaveBeenCalledWith(acquired);
});
it('discards a feed response after account change even if transport ignores cancellation', async () => {
  const old = deferred<{ episodes: typeof episode[] }>(); mocks.request.mockReturnValue(old.promise);
  const [generation, change] = createSignal(1);
  const view = render(() => <PodcastBrowser generation={generation()} subscriptions={[show]} acquired={[]} onPlay={vi.fn()} />);
  fireEvent.click(view.getByText(show.title)); change(2);
  await waitFor(() => expect(mocks.request.mock.calls[0][1].signal.aborted).toBe(true));
  old.resolve({ episodes: [episode] }); await Promise.resolve(); expect(view.queryByText(episode.title)).toBeNull();
});
it('keeps loaded episodes while paginating and deduplicates enclosure identity', async () => {
  mocks.request.mockImplementation((path: string) => Promise.resolve(path.includes('&after=1') ? { episodes: [episode, { ...episode, guid: 'second', title: 'Second episode', enclosure_url: 'https://example.com/second' }], next: null } : path.includes('/queue/status') ? { queue: [] } : { episodes: [episode], next: 1 }));
  const view = render(() => <PodcastBrowser generation={1} subscriptions={[show]} acquired={[]} onPlay={vi.fn()} />);
  fireEvent.click(view.getByText(show.title)); await waitFor(() => expect(view.getByText('Load more episodes')).toBeTruthy());
  fireEvent.click(view.getByText('Load more episodes')); await waitFor(() => expect(view.getByText('Second episode')).toBeTruthy());
  expect(view.getAllByText(episode.title)).toHaveLength(1); expect(mocks.request.mock.calls.some(([path]) => path.includes('&after=1'))).toBe(true);
});
it('offers explicit retry after a failed feed fetch', async () => {
  let failed = false;
  mocks.request.mockImplementation((path: string) => path.includes('recommendations') ? Promise.resolve({ items: [] })
    : path.includes('/episodes') && !failed ? (failed = true, Promise.reject(new Error('offline'))) : Promise.resolve({ episodes: [episode] }));
  const view = render(() => <PodcastBrowser generation={1} subscriptions={[show]} acquired={[]} onPlay={vi.fn()} />);
  fireEvent.click(view.getByText(show.title)); await waitFor(() => expect(view.getByRole('alert')).toBeTruthy());
  fireEvent.click(view.getByText('Retry')); await waitFor(() => expect(view.getByText(episode.title)).toBeTruthy());
});

it('joins the real acquired engine shape using feed and GUID when enclosure is absent', async () => {
  const acquired = { id: 'acquired', title: episode.title, artist: show.title, media_kind: 'podcast_episode', podcast_episode_guid: episode.guid, podcast_feed_id: show.id } as Track;
  const play = vi.fn().mockResolvedValue(undefined);
  const view = render(() => <PodcastBrowser generation={1} subscriptions={[show]} acquired={[acquired]} onPlay={play} />);
  fireEvent.click(view.getByText(show.title)); await waitFor(() => expect(view.getByText(episode.title)).toBeTruthy());
  fireEvent.click(view.getByText(episode.title)); expect(play).toHaveBeenCalledWith({ ...acquired, podcast_enclosure_url: episode.enclosure_url });
});

it('confirms following through the server without acquiring episodes', async () => {
  const changed = vi.fn().mockResolvedValue(undefined); const followed = { ...show, id: 'new-feed' };
  mocks.request.mockImplementation((path: string) => path === '/api/podcasts/subscribe' ? Promise.resolve({ subscription: followed }) : path.startsWith('/api/discovery') ? Promise.resolve({ results: [{ title: show.title, feed_url: show.rss_url }] }) : Promise.resolve({ episodes: [episode] }));
  const view = render(() => <PodcastBrowser generation={1} subscriptions={[]} acquired={[]} onPlay={vi.fn()} onChanged={changed} />);
  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'show' } }); await waitFor(() => expect(view.getByText(show.title)).toBeTruthy());
  fireEvent.click(view.getByText(show.title)); await waitFor(() => expect(view.getByText(episode.title)).toBeTruthy());
  fireEvent.click(view.container.querySelector('[data-podcast-show-menu]')!); mocks.menu.mock.calls[0][0].actions[0].onSelect();
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(mocks.request.mock.calls.some(([path]) => path === '/api/downloader/queue')).toBe(false);
});
it('a stale Follow menu never turns into Unfollow when another client follows', async () => {
  const [subscriptions, set] = createSignal<typeof show[]>([]);
  mocks.request.mockImplementation((path: string) => path.startsWith('/api/discovery') ? Promise.resolve({ results: [{ title: show.title, feed_url: show.rss_url }] }) : Promise.resolve({ episodes: [episode] }));
  const view = render(() => <PodcastBrowser generation={1} subscriptions={subscriptions()} acquired={[]} onPlay={vi.fn()} />);
  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'show' } }); await waitFor(() => expect(view.getByText(show.title)).toBeTruthy());
  fireEvent.click(view.getByText(show.title)); await waitFor(() => expect(view.getByText(episode.title)).toBeTruthy());
  fireEvent.click(view.container.querySelector('[data-podcast-show-menu]')!); set([show]);
  mocks.menu.mock.calls[0][0].actions[0].onSelect(); await Promise.resolve();
  expect(mocks.request.mock.calls.some(([, options]) => options?.method === 'DELETE' || options?.method === 'POST')).toBe(false);
});

it('does not join unrelated unfollowed shows that reuse the same GUID', async () => {
  const unrelated = { id: 'wrong', title: episode.title, artist: 'Other show', media_kind: 'podcast_episode', podcast_episode_guid: episode.guid, podcast_rss_url: 'https://different.example.com/feed' } as Track;
  mocks.request.mockImplementation((path: string) => path.startsWith('/api/discovery') ? Promise.resolve({ results: [{ title: show.title, feed_url: show.rss_url }] }) : Promise.resolve({ episodes: [episode], queue: [] }));
  const play = vi.fn().mockResolvedValue(undefined); const view = render(() => <PodcastBrowser generation={1} subscriptions={[]} acquired={[unrelated]} onPlay={play} />);
  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'show' } }); await waitFor(() => expect(view.getByText(show.title)).toBeTruthy());
  fireEvent.click(view.getByText(show.title)); await waitFor(() => expect(view.getByText(episode.title)).toBeTruthy()); fireEvent.click(view.getByText(episode.title));
  expect(play).toHaveBeenCalledWith(expect.objectContaining({ id: episode.guid, source: 'preview' }));
});

it('refreshes acquired files when an accepted job disappears and reconnects its watcher', async () => {
  const [disconnected, setDisconnected] = createSignal(false);
  const changed = vi.fn().mockResolvedValue(undefined);
  let queue = [{ id: 'job', status: 'downloading', source_type: 'podcast_enclosure', enclosure_url: episode.enclosure_url }];
  mocks.request.mockImplementation((path: string) => Promise.resolve(path.includes('/queue/status') ? { queue } : { episodes: [episode] }));
  const view = render(() => <PodcastBrowser generation={1} subscriptions={[show]} acquired={[]} disconnected={disconnected()} onPlay={vi.fn()} onChanged={changed} />);
  fireEvent.click(view.getByText(show.title));
  await waitFor(() => expect(mocks.request.mock.calls.some(([path]) => path.includes('/queue/status'))).toBe(true));
  await waitFor(() => expect(view.getByText('Downloading…')).toBeTruthy());
  setDisconnected(true); queue = []; setDisconnected(false);
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(view.queryByText('Downloaded')).toBeNull();
});

it('system Back cancels the show request before returning to the directory', async () => {
  const pending = deferred<{episodes: typeof episode[]}>(); mocks.request.mockReturnValue(pending.promise);
  const view = render(() => <PodcastBrowser generation={1} subscriptions={[show]} acquired={[]} onPlay={vi.fn()} />);
  fireEvent.click(view.getByText(show.title));
  const signal = mocks.request.mock.calls[0][1].signal as AbortSignal;
  expect(dispatchNavigationBack()).toBe(true); expect(signal.aborted).toBe(true);
  pending.resolve({ episodes: [episode] }); await Promise.resolve();
  expect(view.queryByText(episode.title)).toBeNull();
  expect(dispatchNavigationBack()).toBe(false);
  view.unmount(); expect(dispatchNavigationBack()).toBe(false);
});

it('shows only downloaded episodes when asked, and forgets the filter for the next show', async () => {
  const acquired = { id: 'acquired', title: episode.title, artist: show.title, media_kind: 'podcast_episode', podcast_episode_guid: episode.guid, podcast_feed_id: show.id } as Track;
  mocks.request.mockImplementation((path: string) => Promise.resolve(path.includes('/queue/status') ? { queue: [] } : path.includes('recommendations') ? { items: [] }
    : { episodes: [episode, { ...episode, guid: 'streamed', title: 'Streamed only', enclosure_url: 'https://example.com/streamed' }], next: null }));
  const view = render(() => <PodcastBrowser generation={1} subscriptions={[show]} acquired={[acquired]} onPlay={vi.fn()} />);
  fireEvent.click(view.getByText(show.title)); await waitFor(() => expect(view.getByText('Streamed only')).toBeTruthy());
  fireEvent.click(view.getByRole('button', { name: 'Downloaded only' }));
  expect(view.queryByText('Streamed only')).toBeNull(); expect(view.getByText(episode.title)).toBeTruthy();
  fireEvent.click(view.getByRole('button', { name: 'Back' })); fireEvent.click(view.getByText(show.title));
  await waitFor(() => expect(view.getByText('Streamed only')).toBeTruthy());
  expect(view.getByRole('button', { name: 'Downloaded only' })).toHaveAttribute('aria-pressed', 'false');
});
