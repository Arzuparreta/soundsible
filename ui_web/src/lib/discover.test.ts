import { expect, it, vi } from 'vitest';
import { request } from './api';
import { ensureDiscover, resetDiscover, recentSaved, revalidating, chartsCountry } from './discover';
import { loadPodcastCountry, podcastCountry } from './podcastCountry';

let account = 'first';
vi.mock('./session', () => ({ user: () => ({ id: account }), userKey: (key: string) => `u:${account}:${key}` }));
vi.mock('./api', () => ({ request: vi.fn() }));
vi.mock('./podcastCountry', () => ({ loadPodcastCountry: vi.fn().mockResolvedValue(undefined), podcastCountry: vi.fn(() => 'us'), resetPodcastCountry: vi.fn() }));

it('old discovery responses cannot populate the next account or overwrite its cache', async () => {
  localStorage.clear();
  const replies: Array<(value: unknown) => void> = [];
  vi.mocked(request).mockImplementation(() => new Promise(resolve => replies.push(resolve)));
  ensureDiscover();
  expect(revalidating()).toBe(true);
  resetDiscover();
  account = 'second';
  ensureDiscover();
  replies[1]({ items: [{ track_id: 'second-song', title: 'second' }] });
  await vi.waitFor(() => expect(replies.length).toBe(4));
  replies[2]({ results: [] }); replies[3]({ results: [] });
  await vi.waitFor(() => expect(recentSaved()[0]?.track_id).toBe('second-song'));
  replies[0]({ items: [{ track_id: 'first-song', title: 'first' }] });
  await vi.waitFor(() => expect(revalidating()).toBe(false));
  expect(recentSaved()[0]?.track_id).toBe('second-song');
  expect(localStorage.getItem('u:second:discover:v3:recent')).not.toContain('first-song');
  resetDiscover();
});

it('loads country charts after reloading with a fresh nonempty music cache', async () => {
  resetDiscover(); localStorage.clear(); account = 'first';
  localStorage.setItem('u:first:discover:v3:recent', JSON.stringify([{ track_id: 'cached-song', title: 'Cached' }]));
  localStorage.setItem('u:first:discover:v3:ts', JSON.stringify(Date.now()));
  vi.mocked(podcastCountry).mockReturnValue(undefined);
  vi.mocked(loadPodcastCountry).mockImplementation(async () => { vi.mocked(podcastCountry).mockReturnValue('us'); });
  vi.mocked(request).mockResolvedValue({ results: [], items: [] });
  ensureDiscover();
  await vi.waitFor(() => expect(revalidating()).toBe(false));
  expect(chartsCountry()).toBe('us');
  expect(request).toHaveBeenCalledWith('/api/discovery/podcasts/top?country=us&limit=20', expect.anything());
  expect(request).toHaveBeenCalledWith('/api/discovery/podcasts/top-episodes?country=us&limit=20', expect.anything());
  resetDiscover();
});
