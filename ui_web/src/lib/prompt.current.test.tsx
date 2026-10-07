import { expect, it } from 'vitest';
import { createSignal } from 'solid-js';
import { cleanup, render, waitFor } from '@solidjs/testing-library';
import { OverlayOutlet } from './overlay';
import { promptDialog } from './prompt';

it('dismisses a pending account-bound prompt when its account is replaced', async () => {
  const [current, change] = createSignal(true);
  render(() => <OverlayOutlet />);
  const result = promptDialog({ title: 'Account playlist', placeholder: 'Name' }, current);
  await waitFor(() => expect(document.body.textContent).toContain('Account playlist'));
  change(false);
  expect(await result).toBeNull();
  cleanup();
});
