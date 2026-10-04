import { beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { createSignal, Show } from 'solid-js';
import NativeSettingsAccount from './SettingsAccount';
import { OverlayOutlet } from '../lib/overlay';
import { createSearchHistoryStorage } from '../lib/searchHistoryStorage';
import { setLocale } from '../lib/i18n';
import type { User } from '../lib/session';
beforeEach(() => { cleanup(); localStorage.clear(); setLocale('en'); });
it('confirms logout through the real overlay after profile and library snapshots change', async () => {
  const original: User = { id: 'member', username: 'member', display_name: 'Member', role: 'member', has_password: true };
  const [user, setUser] = createSignal<User | null>(original), [snapshot, setSnapshot] = createSignal({ revision: 1 });
  const history = createSearchHistoryStorage(key => `confirmation-member:${key}`);
  const logout = vi.fn(async () => { setUser(null); });
  render(() => <><OverlayOutlet /><Show when={user()}>{account => <Show when={snapshot()}>{_data =>
    <NativeSettingsAccount user={account()} identity={() => 1} available={() => true} signal={new AbortController().signal}
      history={history} onUser={vi.fn()} onLogout={logout} />
  }</Show>}</Show></>);
  setUser({ ...original, display_name: 'Updated' }); setSnapshot({ revision: 2 });
  fireEvent.click(screen.getByRole('switch'));
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(logout).toHaveBeenCalledOnce());
  expect(screen.queryByTestId('android-settings-account')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
});
