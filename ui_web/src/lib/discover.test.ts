import { expect, it, vi } from 'vitest';
import { request } from './api';
import { ensureDiscover, resetDiscover, recentSaved, revalidating } from './discover';

let account = 'first';
vi.mock('./session', () => ({ user: () => ({ id: account }), userKey: (key: string) => `u:${account}:${key}` }));
vi.mock('./api', () => ({ request: vi.fn() }));

it('old discovery responses cannot populate the next account or overwrite its cache', async () => {
  localStorage.clear();
  const replies: Array<(value: unknown) => void> = [];
  vi.mocked(request).mockImplementation(() => new Promise(resolve => replies.push(resolve)));
  ensureDiscover();
  expect(revalidating()).toBe(true);
  resetDiscover();
  account = 'second';
  ensureDiscover();
  replies[2]({ items: [{ track_id: 'second-song', title: 'second' }] });
  replies[3]({ items: [] });
  await vi.waitFor(() => expect(recentSaved()[0]?.track_id).toBe('second-song'));
  replies[0]({ items: [{ track_id: 'first-song', title: 'first' }] });
  replies[1]({ items: [] });
  await vi.waitFor(() => expect(revalidating()).toBe(false));
  expect(recentSaved()[0]?.track_id).toBe('second-song');
  expect(localStorage.getItem('u:second:discover:v3:recent')).not.toContain('first-song');
  resetDiscover();
});
