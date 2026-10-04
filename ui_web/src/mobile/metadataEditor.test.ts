import { beforeEach, expect, it, vi } from 'vitest';
import type { MetadataEditorHandlers } from '../components/metadataEditorView';
import type { Track } from '../types/music';
import { openNativeMetadataEditor } from './metadataEditor';
import { request } from '../lib/http';
import { openTrackMetadataEditor } from '../components/metadataEditorView';

vi.mock('../lib/http', () => ({ request: vi.fn() }));
vi.mock('../components/metadataEditorView', () => ({ openTrackMetadataEditor: vi.fn() }));
const track: Track = { id: 'source', title: 'Before', artist: 'Artist', album: '' };
const values = { title: 'After', artist: 'Artist', album: '', album_artist: null };
beforeEach(() => vi.resetAllMocks());
function setup(current = () => true) {
  const refresh = vi.fn(async () => {});
  const update = vi.fn(async () => {});
  openNativeMetadataEditor(track, current, refresh, () => ({ ...track, ...values }), update);
  return { handlers: vi.mocked(openTrackMetadataEditor).mock.calls[0][1] as MetadataEditorHandlers, refresh, update };
}
it('confirms stable source labels before publishing them to the native program', async () => {
  vi.mocked(request).mockResolvedValue({ status: 'success', storage: 'library', id: track.id });
  const { handlers, refresh, update } = setup();
  expect(await handlers.update(values)).toBe(true);
  expect(request).toHaveBeenCalledWith('/api/library/track-labels/source/metadata', expect.objectContaining({ method: 'POST', body: values }));
  expect(refresh).toHaveBeenCalledOnce();
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: track.id, title: 'After' }));
});
it.each([{ status: 'success' }, { status: 'success', storage: 'library', id: 'rehashed' }])('rejects an unconfirmed identity without fallback or queue update', async reply => {
  vi.mocked(request).mockResolvedValue(reply);
  const { handlers, refresh, update } = setup();
  await expect(handlers.update(values)).rejects.toThrow('stable-source');
  expect(request).toHaveBeenCalledOnce();
  expect(refresh).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});
it('never refreshes or changes the replacement account after a pending response', async () => {
  let current = true;
  let resolve!: (value: object) => void;
  vi.mocked(request).mockImplementation(() => new Promise(done => { resolve = done; }));
  const { handlers, refresh, update } = setup(() => current);
  const write = handlers.update(values);
  current = false;
  handlers.dispose?.();
  resolve({ status: 'success', storage: 'library', id: track.id });
  expect(await write).toBe(false);
  expect(refresh).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(vi.mocked(request).mock.calls[0][1]?.signal?.aborted).toBe(true);
});
