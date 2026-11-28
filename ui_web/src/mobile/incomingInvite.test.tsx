import { cleanup, render, waitFor } from '@solidjs/testing-library';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ incoming: vi.fn(), dismiss: vi.fn(), addListener: vi.fn(), remove: vi.fn(), listeners: [] as ((value: { token: string; url: string }) => void)[] }));
vi.mock('./share', () => ({ nativeShare: mocks }));
import { createIncomingLinks } from './incoming';
import { encodeTrackCapsule } from '../lib/trackShare';
const invite = (token: string, origin = 'https://music.example') => ({ token, url: `${origin}/player/#/invite/isolated_invite_token` });
beforeEach(() => {
  cleanup(); vi.resetAllMocks(); mocks.listeners = [];
  mocks.addListener.mockImplementation(async (_name, listener) => { mocks.listeners.push(listener); return { remove: mocks.remove }; });
  mocks.incoming.mockResolvedValue({ incoming: null }); mocks.dismiss.mockResolvedValue({ dismissed: true }); mocks.remove.mockResolvedValue(undefined);
});
function mount() {
  let links!: ReturnType<typeof createIncomingLinks>;
  render(() => { links = createIncomingLinks(); return null; });
  return links;
}
it('exposes only the origin and token of a pending invitation, which the song reader neither shows nor consumes', async () => {
  mocks.incoming.mockResolvedValue({ incoming: invite('cold') });
  const { song, invitation } = mount();
  await waitFor(() => expect(invitation.selection()).toEqual({ token: 'cold', origin: 'https://music.example', invitationToken: 'isolated_invite_token' }));
  expect(mocks.addListener).toHaveBeenCalledTimes(1);
  expect(mocks.incoming).toHaveBeenCalledTimes(1);
  expect(song.selection()).toBeNull(); expect(mocks.dismiss).not.toHaveBeenCalled();
  await invitation.dismiss(); expect(mocks.dismiss).toHaveBeenCalledExactlyOnceWith({ token: 'cold' }); expect(invitation.selection()).toBeNull();
});
it('lets a later song or rejected link replace the invitation without either reader consuming the other', async () => {
  const { song, invitation } = mount(); await waitFor(() => expect(mocks.listeners).toHaveLength(1));
  mocks.listeners[0](invite('first'));
  expect(invitation.selection()?.token).toBe('first');
  const capsule = encodeTrackCapsule({ v: 1, kind: 'music', yt: 'dQw4w9WgXcQ', title: 'Song', artist: 'Artist' });
  mocks.listeners[0]({ token: 'song', url: 'soundsible://open?shared=' + capsule });
  expect(invitation.selection()).toBeNull();
  expect(song.selection()?.token).toBe('song');
  mocks.listeners[0](invite('another'));
  expect(song.selection()).toBeNull();
  expect(invitation.selection()?.token).toBe('another');
  mocks.listeners[0](invite('second', 'https://user:secret@music.example'));
  expect(invitation.selection()).toBeNull(); expect(song.selection()).toBeNull();
  expect(mocks.dismiss).toHaveBeenCalledExactlyOnceWith({ token: 'second' });
});
it('keeps a newer invitation when an older one is dismissed', async () => {
  const { invitation } = mount(); await waitFor(() => expect(mocks.listeners).toHaveLength(1));
  mocks.listeners[0](invite('old'));
  mocks.listeners[0](invite('new', 'http://10.0.2.2:5097'));
  await invitation.dismiss('old');
  expect(invitation.selection()).toEqual({ token: 'new', origin: 'http://10.0.2.2:5097', invitationToken: 'isolated_invite_token' });
});
