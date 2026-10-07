import { cleanup, render, waitFor } from '@solidjs/testing-library';
import { beforeEach, expect, it, vi } from 'vitest';
import { encodeTrackCapsule } from '../lib/trackShare';
const mocks = vi.hoisted(() => ({ incoming: vi.fn(), dismiss: vi.fn(), addListener: vi.fn(), remove: vi.fn(), listener: undefined as undefined | ((value: { token: string; url: string }) => void) }));
vi.mock('./share', () => ({ nativeShare: mocks }));
import { createIncomingTrack } from './incoming';
const link = (token: string, title: string) => ({ token, url: 'soundsible://open?shared=' + encodeTrackCapsule({ v: 1, kind: 'music', yt: 'dQw4w9WgXcQ', title, artist: 'Artist' }) });
beforeEach(() => {
  cleanup(); vi.resetAllMocks(); mocks.listener = undefined;
  mocks.addListener.mockImplementation(async (_name, listener) => { mocks.listener = listener; return { remove: mocks.remove }; });
  mocks.incoming.mockResolvedValue({ incoming: null }); mocks.dismiss.mockResolvedValue({ dismissed: true }); mocks.remove.mockResolvedValue(undefined);
});
function mount() {
  let controller!: ReturnType<typeof createIncomingTrack>;
  const view = render(() => { controller = createIncomingTrack(); return <p>{controller.selection()?.capsule.title ?? ''}</p>; });
  return { view, controller };
}
it('restores a pending cold link and consumes only after explicit dismissal', async () => {
  mocks.incoming.mockResolvedValue({ incoming: link('cold', 'Cold song') });
  const { view, controller } = mount(); await waitFor(() => expect(view.getByText('Cold song')).toBeTruthy());
  expect(mocks.dismiss).not.toHaveBeenCalled(); await controller.dismiss();
  expect(mocks.dismiss).toHaveBeenCalledExactlyOnceWith({ token: 'cold' }); expect(controller.selection()).toBeNull();
});
it('lets a warm intent win over delayed initial state and protects it from an older dismissal', async () => {
  let complete!: (value: { incoming: ReturnType<typeof link> }) => void;
  mocks.incoming.mockReturnValue(new Promise(resolve => complete = resolve));
  const { view, controller } = mount(); await waitFor(() => expect(mocks.incoming).toHaveBeenCalled());
  mocks.listener!(link('new', 'New song')); complete({ incoming: link('old', 'Old song') });
  await waitFor(() => expect(view.getByText('New song')).toBeTruthy());
  await controller.dismiss('old'); expect(controller.selection()?.token).toBe('new');
});
it('discards unsupported URLs without exposing them as a song and releases the listener', async () => {
  const { controller } = mount(); await waitFor(() => expect(mocks.incoming).toHaveBeenCalled());
  mocks.listener!({ token: 'invalid', url: 'https://private.invalid/api/stream?token=secret' });
  expect(controller.selection()).toBeNull(); expect(mocks.dismiss).toHaveBeenCalledWith({ token: 'invalid' });
  cleanup(); expect(mocks.remove).toHaveBeenCalledTimes(1);
});
it('releases late listener registration after unmount without reading or mutating incoming state', async () => {
  let complete!: (value: { remove: typeof mocks.remove }) => void;
  mocks.addListener.mockReturnValue(new Promise(resolve => complete = resolve)); mount(); cleanup(); complete({ remove: mocks.remove });
  await waitFor(() => expect(mocks.remove).toHaveBeenCalled()); expect(mocks.incoming).not.toHaveBeenCalled();
});
