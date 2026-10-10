import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, request } from './api';
import { choosePodcastCountry, countryBusy, loadPodcastCountry, podcastCountries, podcastCountry, resetPodcastCountry } from './podcastCountry';

let account = 'first';
vi.mock('./session', () => ({ user: () => ({ id: account }) }));
vi.mock('./api', () => ({ api: { getDiscoverySettings: vi.fn(), setPodcastCountry: vi.fn() }, request: vi.fn() }));
beforeEach(() => {
  resetPodcastCountry(); account = 'first';
  vi.mocked(api.getDiscoverySettings).mockResolvedValue({ podcast_country: 'es' });
  vi.mocked(request).mockResolvedValue({ countries: ['es', 'mx', 'us'] });
});
afterEach(() => { resetPodcastCountry(); vi.clearAllMocks(); });

it('loads the saved account country and publishes only confirmed selections', async () => {
  await loadPodcastCountry();
  expect(podcastCountry()).toBe('es');
  let complete!: (data: { podcast_country: string }) => void;
  vi.mocked(api.setPodcastCountry).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const saving = choosePodcastCountry('mx');
  expect(countryBusy()).toBe(true);
  expect(podcastCountry()).toBe('es');
  complete({ podcast_country: 'mx' }); await saving;
  expect(podcastCountry()).toBe('mx');
  expect(countryBusy()).toBe(false);
});

it('keeps the previous selection after a failed save', async () => {
  await loadPodcastCountry();
  vi.mocked(api.setPodcastCountry).mockRejectedValue(new Error('offline'));
  await expect(choosePodcastCountry('mx')).rejects.toThrow('offline');
  expect(podcastCountry()).toBe('es'); expect(countryBusy()).toBe(false);
});

it('ignores a late selection receipt after switching accounts', async () => {
  await loadPodcastCountry();
  let complete!: (data: { podcast_country: string }) => void;
  vi.mocked(api.setPodcastCountry).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const saving = choosePodcastCountry('mx');
  account = 'second';
  vi.mocked(api.getDiscoverySettings).mockResolvedValue({ podcast_country: 'us' });
  await loadPodcastCountry();
  complete({ podcast_country: 'mx' }); await saving;
  expect(podcastCountry()).toBe('us'); expect(podcastCountries()).toContain('es');
});

it('a stale settings read cannot undo a confirmed country save', async () => {
  await loadPodcastCountry();
  let oldRead!: (data: { podcast_country: string }) => void;
  vi.mocked(api.getDiscoverySettings).mockImplementation(() => new Promise(resolve => { oldRead = resolve; }));
  const reading = loadPodcastCountry();
  vi.mocked(api.setPodcastCountry).mockResolvedValue({ podcast_country: 'mx' });
  await choosePodcastCountry('mx');
  oldRead({ podcast_country: 'es' }); await reading;
  expect(podcastCountry()).toBe('mx'); expect(countryBusy()).toBe(false);
});
