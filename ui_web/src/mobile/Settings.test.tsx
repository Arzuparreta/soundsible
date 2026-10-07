import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NativeSettings from './Settings';
import { createNativeAppearance } from './appearance';
import { createNativeFeedback } from './feedback';
import { createSearchHistoryStorage } from '../lib/searchHistoryStorage';
import { dispatchNavigationBack } from './backNavigation';
import { setLocale } from '../lib/i18n';
import { createSignal } from 'solid-js';
import type { ProgramState } from '../lib/program/runtime';
vi.mock('./SettingsAccount', () => ({ default: () => <div data-testid="account">Account</div> }));
let preference: ReturnType<typeof createNativeAppearance>;
let feedback: ReturnType<typeof createNativeFeedback>;
beforeEach(() => { localStorage.clear(); void setLocale('en'); preference = createNativeAppearance(() => {}); feedback = createNativeFeedback(async () => ({ accepted: true })); });
afterEach(() => { cleanup(); preference.dispose(); feedback.dispose(); });
it('returns from appearance/accessibility to account before leaving Settings', async () => {
  render(() => <NativeSettings user={{ id: 'member', username: 'member', display_name: 'Member', role: 'member', has_password: true }}
    identity={() => 1} available={() => false} signal={new AbortController().signal} history={createSearchHistoryStorage(key => key)}
    appearance={preference} feedback={feedback} playback={{ state: null, pending: false, available: false, command: vi.fn() }} onUser={vi.fn()} onLogout={vi.fn()}
    library={{ trackCount: () => 0, sync: vi.fn(), onImport: vi.fn() }} online={() => false} />);
  await fireEvent.click(screen.getByRole('button', { name: 'Appearance' }));
  await fireEvent.click(screen.getByRole('radio', { name: 'Pure black' }));
  expect(document.documentElement.dataset.theme).toBe('pure-black');
  expect(dispatchNavigationBack()).toBe(true); expect(screen.getByTestId('account')).toBeVisible();
  await fireEvent.click(screen.getByRole('button', { name: 'Accessibility' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Large' }));
  expect(document.documentElement.dataset.interfaceSize).toBe('large');
  await fireEvent.click(screen.getByRole('switch', { name: /haptics/i }));
  expect(feedback.enabled()).toBe(false);
  expect(localStorage.getItem('haptics')).toBe('off');
  expect(dispatchNavigationBack()).toBe(true);
  await fireEvent.click(screen.getByRole('button', { name: 'Playback' }));
  expect(screen.getByTestId('android-playback-settings')).toBeVisible();
  expect(dispatchNavigationBack()).toBe(true); expect(dispatchNavigationBack()).toBe(false);
});
it('passes the latest native preference through Settings without an optimistic audio state', async () => {
  const [state, setState] = createSignal<Pick<ProgramState, 'ready' | 'autoplay'>>({ ready: true,
    autoplay: { enabled: false, settingsPhase: 'ready', active: false, phase: 'idle' } });
  const command = vi.fn().mockResolvedValue(undefined);
  render(() => <NativeSettings user={{ id: 'member', username: 'member', display_name: 'Member', role: 'member', has_password: true }}
    identity={() => 1} available={() => true} signal={new AbortController().signal} history={createSearchHistoryStorage(key => key)}
    appearance={preference} feedback={feedback} playback={{ state: state(), pending: false, available: true, command }} onUser={vi.fn()} onLogout={vi.fn()}
    library={{ trackCount: () => 0, sync: vi.fn(), onImport: vi.fn() }} online={() => false} />);
  await fireEvent.click(screen.getByRole('button', { name: 'Playback' }));
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  setState({ ready: true, autoplay: { enabled: true, settingsPhase: 'ready', active: false, phase: 'idle' } });
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await fireEvent.click(screen.getByRole('switch'));
  expect(command).toHaveBeenCalledWith({ action: 'autoplay', enabled: false, reload: false });
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
});
it('searches settings the web way and opens the matching tab, Back clearing the search first', async () => {
  render(() => <NativeSettings user={{ id: 'member', username: 'member', display_name: 'Member', role: 'member', has_password: true }}
    identity={() => 1} available={() => false} signal={new AbortController().signal} history={createSearchHistoryStorage(key => key)}
    appearance={preference} feedback={feedback} playback={{ state: null, pending: false, available: false, command: vi.fn() }} onUser={vi.fn()} onLogout={vi.fn()}
    library={{ trackCount: () => 0, sync: vi.fn(), onImport: vi.fn() }} online={() => false} />);
  await fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'contrast' } });
  const result = (anchor: string) => document.querySelector(`[data-settings-result="${anchor}"]`) as HTMLElement | null;
  await fireEvent.click(result('high-contrast')!);
  expect(screen.getByRole('button', { name: 'Accessibility' })).toHaveAttribute('aria-pressed', 'true');
  await fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'quality' } });
  expect(result('quality')).toBeNull();
  await fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'bottom bar' } });
  expect(result('bottom-bar')).toBeNull();
  expect(dispatchNavigationBack()).toBe(true); expect(screen.getByRole('searchbox')).toHaveValue('');
  await fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'learn' } });
  await fireEvent.click(screen.getAllByRole('button').find(button => button.dataset.settingsResult === 'learn-activity')!);
  expect(screen.getByRole('button', { name: 'Recommendations' })).toHaveAttribute('aria-pressed', 'true');
});
