import { beforeEach, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { setLocale } from '../lib/i18n';
import PodcastBrowser from './PodcastBrowser';
import type { Track } from '../types/music';
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../lib/http', () => ({ request: mocks.request }));
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
  mocks.request.mockResolvedValueOnce({ episodes: [episode], next: 1 }).mockResolvedValueOnce({ episodes: [episode, { ...episode, guid: 'second', title: 'Second episode', enclosure_url: 'https://example.com/second' }], next: null });
  const view = render(() => <PodcastBrowser generation={1} subscriptions={[show]} acquired={[]} onPlay={vi.fn()} />);
  fireEvent.click(view.getByText(show.title)); await waitFor(() => expect(view.getByText('Load more episodes')).toBeTruthy());
  fireEvent.click(view.getByText('Load more episodes')); await waitFor(() => expect(view.getByText('Second episode')).toBeTruthy());
  expect(view.getAllByText(episode.title)).toHaveLength(1); expect(mocks.request.mock.calls[1][0]).toContain('&after=1');
});
it('offers explicit retry after a failed feed fetch', async () => {
  mocks.request.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ episodes: [episode] });
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
