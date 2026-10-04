import { beforeEach, expect, it, vi } from 'vitest';
import { nativeEntityMark } from './entityMarks';
import { request } from '../lib/http';
import type { SavedEntity } from '../lib/savedEntityIdentity';
vi.mock('../lib/http', () => ({ request: vi.fn() }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
const entry: SavedEntity = { kind: 'album', name: 'Same name', destination: '/album/Same?album_id=one' };
beforeEach(() => vi.resetAllMocks());
it('saves only a bookmark with explicit intent and suppresses duplicate selection while pending', async () => {
  const refresh = vi.fn(async () => {});
  vi.mocked(request).mockResolvedValue({ entities: [entry] });
  const action = nativeEntityMark(entry, () => [], () => true, refresh, vi.fn());
  action.onSelect(); action.onSelect();
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith('/api/library/saved-entities', expect.objectContaining({ method: 'PUT', body: { entry, saved: true } }));
});
it('rejects a namesake instead of claiming the requested identity was confirmed', async () => {
  const failed = vi.fn(), refresh = vi.fn(async () => {});
  vi.mocked(request).mockResolvedValue({ entities: [{ ...entry, destination: '/album/Same?album_id=other' }] });
  nativeEntityMark(entry, () => [], () => true, refresh, failed).onSelect();
  await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce()); expect(refresh).not.toHaveBeenCalled();
});
it('removes the captured bookmark without toggling a subsequent snapshot', async () => {
  const refresh = vi.fn(async () => {});
  vi.mocked(request).mockResolvedValue({ entities: [] });
  const action = nativeEntityMark(entry, () => [entry], () => true, refresh, vi.fn());
  expect(action.selected).toBe(true); action.onSelect();
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(request).toHaveBeenCalledWith('/api/library/saved-entities', expect.objectContaining({ body: { entry, saved: false } }));
});
it('a pending bookmark response cannot refresh the replacement account', async () => {
  let current = true, resolve!: (value: object) => void;
  vi.mocked(request).mockImplementation(() => new Promise(done => { resolve = done; }));
  const refresh = vi.fn(async () => {}), failed = vi.fn();
  nativeEntityMark(entry, () => [], () => current, refresh, failed).onSelect();
  current = false; resolve({ entities: [entry] }); await Promise.resolve(); await Promise.resolve();
  expect(refresh).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
});
