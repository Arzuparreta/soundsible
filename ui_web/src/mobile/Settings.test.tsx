import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NativeSettings from './Settings';
import { createNativeAppearance } from './appearance';
import { createNativeFeedback } from './feedback';
import { createSearchHistoryStorage } from '../lib/searchHistoryStorage';
import { dispatchNavigationBack } from './backNavigation';
import { setLocale } from '../lib/i18n';
vi.mock('./SettingsAccount', () => ({ default: () => <div data-testid="account">Account</div> }));
let preference: ReturnType<typeof createNativeAppearance>;
let feedback: ReturnType<typeof createNativeFeedback>;
beforeEach(() => { localStorage.clear(); void setLocale('en'); preference = createNativeAppearance(() => {}); feedback = createNativeFeedback(async () => ({ accepted: true })); });
afterEach(() => { cleanup(); preference.dispose(); feedback.dispose(); });
it('returns from appearance/accessibility to account before leaving Settings', async () => {
  render(() => <NativeSettings user={{ id: 'member', username: 'member', display_name: 'Member', role: 'member', has_password: true }}
    identity={() => 1} available={() => false} signal={new AbortController().signal} history={createSearchHistoryStorage(key => key)}
    appearance={preference} feedback={feedback} onUser={vi.fn()} onLogout={vi.fn()} />);
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
  expect(dispatchNavigationBack()).toBe(true); expect(dispatchNavigationBack()).toBe(false);
});
