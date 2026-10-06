import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { beforeEach, expect, it, vi } from 'vitest';
import IncomingSong from './IncomingSong';
import type { Track } from '../types/music';
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
const capsule = { v: 1 as const, kind: 'music' as const, yt: 'dQw4w9WgXcQ', title: 'Shared song', artist: 'Artist' };
const song = { id: 'local-match', title: 'Held song', artist: 'Artist' } as Track;
beforeEach(cleanup);
function mount(disabled = false) {
  const [selection, setSelection] = createSignal<{ token: string; capsule: typeof capsule } | null>({ token: 'incoming', capsule });
  const dismiss = vi.fn(async (_token?: string) => {}), onPlay = vi.fn(async (_track: Track) => {}), onMenu = vi.fn();
  const view = render(() => <IncomingSong incoming={{ selection, dismiss }} track={() => song} disabled={disabled} onPlay={onPlay} onMenu={onMenu} />);
  return { view, setSelection, dismiss, onPlay, onMenu };
}
it('does not play or consume on arrival; plays the current account local match only after an explicit action', async () => {
  const { view, onPlay, dismiss } = mount(); expect(onPlay).not.toHaveBeenCalled(); expect(dismiss).not.toHaveBeenCalled();
  await fireEvent.click(view.getByText('common.play'));
  await waitFor(() => expect(dismiss).toHaveBeenCalledWith('incoming')); expect(onPlay).toHaveBeenCalledExactlyOnceWith(song);
});
it('blocks unauthenticated/unavailable playback but allows dismissing the public selection', async () => {
  const { view, onPlay, dismiss } = mount(true);
  await fireEvent.click(view.getByText('common.play')); expect(onPlay).not.toHaveBeenCalled();
  await fireEvent.click(view.getByText('common.close')); expect(dismiss).toHaveBeenCalledWith('incoming');
});
it('keeps a failed selection available to retry and does not apply its error to a newer intent', async () => {
  const { view, setSelection, onPlay, dismiss } = mount(); onPlay.mockRejectedValueOnce(new Error('unavailable'));
  await fireEvent.click(view.getByText('common.play')); await waitFor(() => expect(view.getByRole('alert')).toBeTruthy());
  expect(dismiss).not.toHaveBeenCalled(); setSelection({ token: 'new', capsule: { ...capsule, title: 'New song' } });
  expect(view.queryByRole('alert')).toBeNull();
});
