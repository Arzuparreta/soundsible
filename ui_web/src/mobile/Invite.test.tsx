import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import NativeInvite from './Invite';
import { setLocale } from '../lib/i18n';
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../lib/http', () => ({ request: mocks.request }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
async function setup(current = () => true) {
  setLocale('en'); mocks.request.mockResolvedValueOnce({ valid: true });
  const accepted = vi.fn().mockResolvedValue(undefined), cancel = vi.fn();
  const view = render(() => <NativeInvite token="isolated_invite_token" current={current} onAccepted={accepted} onCancel={cancel} />);
  await waitFor(() => expect(view.container.querySelector('input[autocomplete=username]')).not.toBeNull());
  return { ...view, accepted, cancel };
}
it('requires confirmed password and uses the native transport before handing the account to its owner', async () => {
  const view = await setup(); mocks.request.mockResolvedValue({ user: { id: 'new-user' } });
  const input = view.container.querySelector('input[autocomplete=username]')!;
  fireEvent.input(input, { target: { value: ' invited ' } });
  const passwords = view.container.querySelectorAll('input[autocomplete=new-password]');
  fireEvent.input(passwords[0], { target: { value: 'synthetic-password' } });
  expect(view.getByRole('button', { name: 'Create my account' })).toBeDisabled();
  fireEvent.input(passwords[1], { target: { value: 'synthetic-password' } });
  await waitFor(() => expect(view.getByRole('button', { name: 'Create my account' })).toBeEnabled());
  fireEvent.submit(view.container.querySelector('form')!);
  await waitFor(() => expect(view.accepted).toHaveBeenCalledOnce());
  expect(mocks.request).toHaveBeenLastCalledWith('/api/invites/isolated_invite_token/accept', expect.objectContaining({
    method: 'POST', body: { username: 'invited', password: 'synthetic-password', device_name: 'Soundsible Android' }, signal: expect.any(AbortSignal),
  }));
});
it('does not adopt a late acceptance after account ownership changes', async () => {
  let current = true, complete!: () => void;
  const view = await setup(() => current);
  mocks.request.mockReturnValue(new Promise(resolve => { complete = () => resolve({ user: { id: 'stale' } }); }));
  fireEvent.input(view.container.querySelector('input[autocomplete=username]')!, { target: { value: 'invited' } });
  for (const input of view.container.querySelectorAll('input[autocomplete=new-password]')) fireEvent.input(input, { target: { value: 'synthetic-password' } });
  await waitFor(() => expect(view.getByRole('button', { name: 'Create my account' })).toBeEnabled());
  fireEvent.submit(view.container.querySelector('form')!);
  await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
  current = false; complete(); await Promise.resolve();
  expect(view.accepted).not.toHaveBeenCalled();
});
it('invalid or used invitation offers cancellation without an acceptance form', async () => {
  setLocale('en'); mocks.request.mockRejectedValue(new Error('invalid invite'));
  const cancel = vi.fn(), accepted = vi.fn();
  const view = render(() => <NativeInvite token="isolated_invite_token" current={() => true} onAccepted={accepted} onCancel={cancel} />);
  await waitFor(() => expect(view.getByText('This link no longer works')).toBeInTheDocument());
  expect(view.container.querySelector('form')).toBeNull();
  fireEvent.click(view.getByRole('button', { name: 'Cancel' })); expect(cancel).toHaveBeenCalledOnce(); expect(accepted).not.toHaveBeenCalled();
});

it('does not label a pending preview as an invalid invitation', () => {
  setLocale('en'); mocks.request.mockReturnValue(new Promise(() => {}));
  const view = render(() => <NativeInvite token="isolated_invite_token" current={() => true} onAccepted={vi.fn()} onCancel={vi.fn()} />);
  expect(view.queryByText('Ask for a new one.')).not.toBeInTheDocument();
  expect(view.container.querySelector('form')).toBeNull();
});
