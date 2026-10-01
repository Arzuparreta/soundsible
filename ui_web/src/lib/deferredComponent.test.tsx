import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';
import { expect, it, vi } from 'vitest';
import { deferredComponent } from './deferredComponent';

it('retries an import failure and caches code without retaining a disposed view', async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ default: (props: { label: string }) => <p>{props.label}</p> });
  const View = deferredComponent<{ label: string }>(load);
  const first = render(() => <View label="first" />);
  await waitFor(() => expect(screen.getByRole('button')).toBeVisible());
  fireEvent.click(screen.getByRole('button'));
  await screen.findByText('first');
  first.unmount();
  render(() => <View label="second" />);
  await screen.findByText('second');
  expect(load).toHaveBeenCalledTimes(2);
});

it('does not mount a view when its owner closes during import', async () => {
  let release!: (module: { default: () => HTMLElement }) => void;
  const View = deferredComponent(() => new Promise<{ default: () => HTMLElement }>(resolve => { release = resolve; }));
  const mounted = vi.fn(() => document.createElement('div'));
  const page = render(() => <View />);
  page.unmount();
  release({ default: mounted });
  await Promise.resolve();
  await Promise.resolve();
  expect(mounted).not.toHaveBeenCalled();
});
