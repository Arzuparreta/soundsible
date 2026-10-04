import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { OverlayOutlet } from '../lib/overlay';
import { openTrackMetadataEditor } from './metadataEditorView';
import type { Track } from '../types/music';
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
afterEach(cleanup);
const track = { id: 'song', title: 'Original', artist: 'Artist', album: 'Album' } as Track;
const handlers = () => ({ update: vi.fn(async () => true), upload: vi.fn(async () => {}), remove: vi.fn(async () => {}) });
it('submits trimmed editable tags and closes only after confirmed success', async () => {
  render(() => <OverlayOutlet />); const writes = handlers(); openTrackMetadataEditor(track, writes);
  await fireEvent.input(screen.getByLabelText('metadataEditor.fieldTitle'), { target: { value: ' Edited ' } });
  await fireEvent.click(screen.getByText('metadataEditor.save'));
  await waitFor(() => expect(document.querySelector('[data-track-metadata-editor]')).toBeNull());
  expect(writes.update).toHaveBeenCalledExactlyOnceWith({ title: 'Edited', artist: 'Artist', album: 'Album', album_artist: null });
});
it('retains edits after a failed write and permits retry', async () => {
  render(() => <OverlayOutlet />); const writes = handlers(); writes.update.mockRejectedValueOnce(new Error('unavailable'));
  openTrackMetadataEditor(track, writes); await fireEvent.click(screen.getByText('metadataEditor.save'));
  expect(await screen.findByRole('alert')).toHaveTextContent('common.loadFailed');
  expect((screen.getByLabelText('metadataEditor.fieldTitle') as HTMLInputElement).value).toBe('Original');
  await fireEvent.click(screen.getByText('metadataEditor.save'));
  await waitFor(() => expect(document.querySelector('[data-track-metadata-editor]')).toBeNull());
  expect(writes.update).toHaveBeenCalledTimes(2);
});
it('closes and disposes pending writes when the captured account is replaced', async () => {
  render(() => <OverlayOutlet />); const [current, setCurrent] = createSignal(true);
  let finish!: (result: boolean) => void; const dispose = vi.fn();
  const writes = { ...handlers(), update: vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; })), current, dispose };
  openTrackMetadataEditor(track, writes); await fireEvent.click(screen.getByText('metadataEditor.save'));
  setCurrent(false);
  await waitFor(() => expect(document.querySelector('[data-track-metadata-editor]')).toBeNull());
  expect(dispose).toHaveBeenCalledOnce(); finish(true);
  await Promise.resolve(); expect(document.querySelector('[data-track-metadata-editor]')).toBeNull();
});
