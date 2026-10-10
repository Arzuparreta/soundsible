import { beforeEach, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import PodcastBrowser from './PodcastBrowser';
import { setLocale, t } from '../lib/i18n';
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../lib/http', () => ({ request: mocks.request }));
const feed = 'https://example.com/rss';
const news = [{ id: '1489', name: 'News' }], comedy = [{ id: '1303', name: 'Comedy' }];
const show = { title: 'Ranked show', feed_url: feed, genres: news };
const episode = { guid: 'guid-900', title: 'Exact chapter', enclosure_url: 'https://example.com/audio.mp3' };
beforeEach(() => {
  cleanup(); setLocale('en'); vi.clearAllMocks();
  mocks.request.mockImplementation((path: string, options?: { body?: { podcast_country?: string } }) => Promise.resolve(
    path.endsWith('/settings') ? { podcast_country: options?.body?.podcast_country ?? 'es' }
      : path.endsWith('/countries') ? { countries: ['es', 'us'] }
      : path.includes('/top-episodes?') ? { results: [{ ...show, title: 'Ranked chapter', episode_id: '900', itunes_collection_id: '123' }] }
      : path.includes('/top?') ? { results: [show, { ...show, title: 'Comedy show', genres: comedy }] }
      : path.includes('/episode?') ? { episode, show_title: show.title, feed_url: feed }
      : { items: [], episodes: [] }));
});
it('shows both country rankings including followed shows, filters categories and plays the exact local chapter', async () => {
  const local = { id: 'downloaded', title: episode.title, artist: show.title, podcast_episode_guid: episode.guid, podcast_rss_url: feed };
  const play = vi.fn().mockResolvedValue(undefined);
  const view = render(() => <PodcastBrowser generation={1} subscriptions={[{ id: 'followed', title: 'Followed', rss_url: feed }]} acquired={[local]} onPlay={play} />);
  await waitFor(() => expect(view.getByText('Ranked chapter')).toBeTruthy());
  expect(view.getByText('Ranked show')).toBeTruthy();
  expect(view.getByText('Popular episodes in Spain')).toBeTruthy();
  fireEvent.change(view.getByRole('combobox', { name: t('podcasts.category') }), { target: { value: '1489' } });
  expect(view.queryByText('Comedy show')).toBeNull(); expect(view.getByText('Ranked chapter')).toBeTruthy(); expect(view.getByText('Followed')).toBeTruthy();
  expect(mocks.request.mock.calls.some(([path]) => String(path).includes('/episode?'))).toBe(false);
  fireEvent.click(view.getByText('Ranked chapter'));
  await waitFor(() => expect(play).toHaveBeenCalledWith(local));
  expect(mocks.request.mock.calls.find(([path]) => String(path).includes('/episode?'))![0]).toContain('episode_id=900&country=es');
  fireEvent.change(view.getByRole('combobox', { name: t('podcasts.country') }), { target: { value: 'us' } });
  await waitFor(() => expect(view.getByText('Popular episodes in United States')).toBeTruthy());
  expect(view.getByRole('combobox', { name: t('podcasts.category') })).toHaveValue('');
  expect(mocks.request.mock.calls.some(([path]) => String(path).includes('/top?country=us'))).toBe(true);
});
it('does not play a late episode result after account change', async () => {
  let complete!: (result: unknown) => void;
  const original = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation((path: string, options?: unknown) => path.includes('/episode?') ? new Promise(resolve => { complete = resolve; }) : original(path, options));
  const [generation, change] = createSignal(1), play = vi.fn();
  const view = render(() => <PodcastBrowser generation={generation()} subscriptions={[]} acquired={[]} onPlay={play} />);
  await waitFor(() => expect(view.getByText('Ranked chapter')).toBeTruthy());
  fireEvent.click(view.getByText('Ranked chapter')); change(2);
  complete({ episode, show_title: show.title, feed_url: feed }); await Promise.resolve();
  expect(play).not.toHaveBeenCalled();
});
