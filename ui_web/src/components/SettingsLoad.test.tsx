import { fireEvent, render, screen } from '@solidjs/testing-library';
import { expect, it, vi } from 'vitest';
import { SettingsLoad } from './SettingsLoad';

it('withholds editable defaults, settles failures and retries server settings', async () => {
  let reject!: (error: Error) => void;
  const load = vi.fn().mockImplementationOnce(() => new Promise((_yes, no) => { reject = no; })).mockResolvedValue(undefined);
  render(() => <SettingsLoad load={load}><button>Real setting</button></SettingsLoad>);
  expect(screen.getByRole('status')).toBeInTheDocument();
  expect(screen.queryByText('Real setting')).toBeNull();
  reject(new Error('offline'));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  await screen.findByRole('button', { name: 'Real setting' });
  expect(load).toHaveBeenCalledTimes(2);
});
