import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { JSX } from 'solid-js';
import Podcasts from './Podcasts';
import { setLocale } from '../lib/i18n';
const mocks = vi.hoisted(() => ({ request: vi.fn(), country: vi.fn<() => string>(), setCountry: vi.fn<(code: string) => void>(), play: vi.fn(), error: vi.fn() }));
vi.mock('../lib/podcastCountry', async () => {
  const { createSignal } = await import('solid-js');
  const [country, setCountry] = createSignal('us');
  mocks.country.mockImplementation(country); mocks.setCountry.mockImplementation(setCountry);
  return { podcastCountry: mocks.country, countryName: (code: string) => code };
});
vi.mock('../components/PodcastCountryPicker', () => ({ PodcastCountryPicker: () => null }));
vi.mock('../components/NavigationMenu', () => ({ NavigationMenuButton: () => null }));
vi.mock('../lib/appBar', () => ({ useAppBar: vi.fn() }));
vi.mock('@solidjs/router', () => ({ useNavigate: () => vi.fn(), useSearchParams: () => [{}, vi.fn()],
  A: (props: { href: string; children: JSX.Element }) => <a href={props.href}>{props.children}</a> }));
vi.mock('../lib/session', () => ({ user: () => ({ id: 'account' }) }));
vi.mock('../lib/api', () => ({ request: mocks.request, api: {} }));
vi.mock('../lib/discover', () => ({ ensureDiscover: vi.fn(), refreshDiscover: vi.fn(), topPodcasts: () => [],
  chartsCountry: mocks.country, chartFailed: () => false, episodesFailed: () => false, revalidating: () => false,
  topEpisodes: () => [{ title: `Chapter ${mocks.country()}`, episode_id: mocks.country(), itunes_collection_id: '123', feed_url: 'https://example.com/rss' }] }));
vi.mock('../stores', () => ({ state: { podcastSubscriptions: [], library: [], playback: { currentTrack: null } }, actions: { playEpisode: mocks.play } }));
vi.mock('../components/MusicListRow', () => ({ MusicListRow: (props: { title: string; busy?: boolean; onActivate(): void }) =>
  <button disabled={props.busy} onClick={props.onActivate}>{props.title}</button> }));
vi.mock('../lib/toast', () => ({ toast: { error: mocks.error } }));
beforeEach(() => { vi.clearAllMocks(); setLocale('en'); mocks.setCountry('us'); mocks.play.mockResolvedValue(undefined); });
afterEach(cleanup);

it('cancels the previous country lookup and keeps a newer pending lookup busy when the old response arrives', async () => {
  const jobs: { signal: AbortSignal; resolve(value: unknown): void }[] = [];
  mocks.request.mockImplementation((_path: string, options: { signal: AbortSignal }) => new Promise(resolve => jobs.push({ signal: options.signal, resolve })));
  const view = render(() => <Podcasts />);
  fireEvent.click(view.getByText('Chapter us'));
  expect(jobs).toHaveLength(1);
  mocks.setCountry('es');
  expect(jobs[0].signal.aborted).toBe(true);
  expect(view.getByText('Chapter es')).not.toBeDisabled();
  fireEvent.click(view.getByText('Chapter es'));
  expect(jobs).toHaveLength(2);
  const result = (country: string) => ({ show_title: 'Show', feed_url: 'https://example.com/rss',
    episode: { guid: country, title: country, enclosure_url: `https://example.com/${country}.mp3` } });
  jobs[0].resolve(result('us')); await Promise.resolve(); await Promise.resolve();
  expect(mocks.play).not.toHaveBeenCalled();
  expect(view.getByText('Chapter es')).toBeDisabled();
  jobs[1].resolve(result('es'));
  await waitFor(() => expect(mocks.play).toHaveBeenCalledOnce());
  expect(mocks.play).toHaveBeenCalledWith(result('es').episode, 'Show', 'https://example.com/rss', undefined);
  expect(mocks.error).not.toHaveBeenCalled();
});
