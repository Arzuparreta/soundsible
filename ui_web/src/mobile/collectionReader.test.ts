import { beforeEach, expect, it, vi } from 'vitest';
import { createNativeCollectionReader } from './collectionReader';
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../lib/http', () => mocks);
beforeEach(() => mocks.request.mockReset());
const snapshot = { items: [{ id: 'video', item_id: 'stable', title: 'Song', artist: 'A', source: 'preview' }],
  files: [], saved: [], playlists: { Mix: ['stable'] }, settings: {}, podcast_subscriptions: [] };
it('negotiates once, then refreshes only the canonical resource with its validator', async () => {
  mocks.request.mockImplementationOnce(async (_path, options) => {
    options.onResponse(new Response(null, { headers: { 'X-Soundsible-Collection': 'true' } }));
    return { tracks: [] };
  }).mockImplementationOnce(async (_path, options) => { options.onETag('one'); return snapshot; }).mockResolvedValueOnce(null);
  const read = createNativeCollectionReader(); const signal = new AbortController().signal;
  const first = await read(signal);
  expect(first.snapshot.playlists).toEqual({ Mix: ['stable'] });
  expect(first.snapshot.tracks[0].item_id).toBe('stable');
  expect(await read(signal)).toBe(first);
  expect(mocks.request.mock.calls.map(call => call[0])).toEqual(['/api/library', '/api/library/collection', '/api/library/collection']);
  expect(mocks.request.mock.calls[2][1].ifNoneMatch).toBe('one');
});
it('a new account reader starts with no capability or validator from the previous one', async () => {
  mocks.request.mockResolvedValueOnce({ tracks: [] }).mockResolvedValueOnce({ saved: [] });
  await createNativeCollectionReader()(new AbortController().signal);
  expect(mocks.request.mock.calls.map(call => call[0])).toEqual(['/api/library', '/api/library/saved']);
  expect(mocks.request.mock.calls[0][1].ifNoneMatch).toBeUndefined();
});

it('keeps podcast items out of music browse while retaining acquired podcast sources', async () => {
  const episode = { id: 'episode-file', item_id: 'episode-item', title: 'Episode', artist: 'Show', media_kind: 'podcast_episode' };
  mocks.request.mockImplementationOnce(async (_path, options) => {
    options.onResponse(new Response(null, { headers: { 'X-Soundsible-Collection': 'true' } }));
    return { tracks: [] };
  }).mockResolvedValueOnce({ ...snapshot, items: [...snapshot.items, episode], files: [episode] });
  const result = await createNativeCollectionReader()(new AbortController().signal);
  expect(result.snapshot.tracks.map(track => track.item_id)).toEqual(['stable']);
  expect(result.snapshot.podcast_tracks).toEqual([episode]);
});
