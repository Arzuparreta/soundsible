import { fireEvent, render, screen } from '@solidjs/testing-library';
import { expect, it, vi } from 'vitest';
import Downloads from './Downloads';

const load = vi.hoisted(() => vi.fn());
vi.mock('../stores', () => ({
  state: { downloads: { queue: [], recent: [] } },
  actions: { loadDownloads: load },
  downloadCounts: () => ({ active: 0, failed: 0 }),
}));
vi.mock('../lib/scrollHistory', () => ({ registerPrimaryScroll: vi.fn() }));

it('distinguishes a pending queue, a failed request and a confirmed empty queue', async () => {
  let settle!: (ok: boolean) => void;
  load.mockImplementationOnce(() => new Promise<boolean>(resolve => { settle = resolve; })).mockResolvedValue(true);
  render(() => <Downloads />);
  expect(screen.getByRole('status', { name: 'Loading…' })).toBeInTheDocument();
  settle(false);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull());
  expect(load).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
});
