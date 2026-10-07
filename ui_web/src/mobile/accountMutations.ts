import { request } from '../lib/http';
import type { User } from '../lib/session';

/** Own-account writes confirmed against auth/state before updating the installed client. */
export function createNativeAccountMutations(identity: () => number, user: () => User | null,
  ready: () => boolean, signal: () => AbortSignal, changed: (user: User) => Promise<void>) {
  async function mutate(path: string, body: object, profile?: { display_name?: string; username?: string }): Promise<boolean> {
    const epoch = identity(), account = user()?.id;
    if (!account || !ready()) throw new Error('Account unavailable');
    const current = () => identity() === epoch && user()?.id === account && ready();
    const reply = await request<{ status?: string; user?: User }>(path, { method: 'POST', body, signal: signal(), timeoutMs: 15000 });
    if (!current()) return false;
    if (reply.user?.id !== account || (!profile && reply.status !== 'ok')) throw new Error('Missing account confirmation');
    const state = await request<{ user: User | null }>('/api/auth/state', { signal: signal(), cache: 'no-store', timeoutMs: 15000 });
    if (!current()) return false;
    if (state.user?.id !== account || (!profile && !state.user.has_password)
      || (profile?.display_name !== undefined && state.user.display_name !== profile.display_name)
      || (profile?.username !== undefined && state.user.username !== profile.username)) throw new Error('Account snapshot did not confirm mutation');
    await changed(state.user);
    return current();
  }
  return {
    profile: (patch: { display_name?: string; username?: string }) => mutate('/api/auth/profile', patch, patch),
    password: (currentPassword: string, newPassword: string) => mutate('/api/auth/password', { current_password: currentPassword, new_password: newPassword }),
  };
}
