import { cleanup, render, waitFor } from '@solidjs/testing-library';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ incoming: vi.fn(), dismiss: vi.fn(), addListener: vi.fn(), remove: vi.fn(), listeners: [] as ((value: { token: string; url: string }) => void)[] }));
vi.mock('./share', () => ({ nativeShare: mocks }));
import { createIncomingInvite } from './incomingInvite';
import { createIncomingTrack } from './incoming';
const invite = (token: string, origin = 'https://music.example') => ({ token, url: `${origin}/player/#/invite/isolated_invite_token` });
beforeEach(() => {
  cleanup(); vi.resetAllMocks(); mocks.listeners = [];
  mocks.addListener.mockImplementation(async (_name, listener) => { mocks.listeners.push(listener); return { remove: mocks.remove }; });
  mocks.incoming.mockResolvedValue({ incoming: null }); mocks.dismiss.mockResolvedValue({ dismissed: true }); mocks.remove.mockResolvedValue(undefined);
});
function mount() {
  let song!: ReturnType<typeof createIncomingTrack>, invitation!: ReturnType<typeof createIncomingInvite>;
  render(() => { song = createIncomingTrack(); invitation = createIncomingInvite(); return null; });
  return { song: () => song, invitation: () => invitation };
}
it('exposes only the origin and token of a pending invitation, which the song reader neither shows nor consumes', async () => {
  mocks.incoming.mockResolvedValue({ incoming: invite('cold') });
  const { song, invitation } = mount();
  await waitFor(() => expect(invitation().selection()).toEqual({ token: 'cold', origin: 'https://music.example', invitationToken: 'isolated_invite_token' }));
  expect(song().selection()).toBeNull(); expect(mocks.dismiss).not.toHaveBeenCalled();
  await invitation().dismiss(); expect(mocks.dismiss).toHaveBeenCalledExactlyOnceWith({ token: 'cold' }); expect(invitation().selection()).toBeNull();
});
it('lets a later song or rejected link replace the invitation without either reader consuming the other', async () => {
  const { song, invitation } = mount(); await waitFor(() => expect(mocks.listeners).toHaveLength(2));
  for (const listener of mocks.listeners) listener(invite('first'));
  expect(invitation().selection()?.token).toBe('first');
  for (const listener of mocks.listeners) listener(invite('second', 'https://user:secret@music.example'));
  expect(invitation().selection()).toBeNull(); expect(song().selection()).toBeNull();
  expect(mocks.dismiss).toHaveBeenCalledExactlyOnceWith({ token: 'second' });
});
it('keeps a newer invitation when an older one is dismissed', async () => {
  const { invitation } = mount(); await waitFor(() => expect(mocks.listeners).toHaveLength(2));
  for (const listener of mocks.listeners) listener(invite('old'));
  for (const listener of mocks.listeners) listener(invite('new', 'http://10.0.2.2:5097'));
  await invitation().dismiss('old');
  expect(invitation().selection()).toEqual({ token: 'new', origin: 'http://10.0.2.2:5097', invitationToken: 'isolated_invite_token' });
});
