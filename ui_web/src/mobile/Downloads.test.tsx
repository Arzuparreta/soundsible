import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';
import { beforeEach, expect, it, vi } from 'vitest';
import NativeDownloads from './Downloads';
import { request } from '../lib/http';
vi.mock('../lib/http', () => ({ request: vi.fn() }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
beforeEach(() => vi.resetAllMocks());
it('does not remove a row optimistically when the refreshed queue still contains it', async () => {
  vi.mocked(request).mockResolvedValue({ status: 'removed' });
  const refresh = vi.fn(async () => {});
  render(() => <NativeDownloads generation={1} disconnected={false} items={[{ id: 'job', status: 'downloading', display_title: 'Song' }]} onChanged={refresh} />);
  fireEvent.click(screen.getByRole('button', { name: 'downloads.ariaCancel' }));
  await screen.findByRole('alert');
  expect(refresh).toHaveBeenCalledOnce(); expect(screen.getByText('Song')).toBeVisible();
  expect(request).toHaveBeenCalledWith('/api/downloader/queue/job', expect.objectContaining({ method: 'DELETE' }));
  expect(screen.queryByText('downloads.clearQueue')).toBeNull();
});
it('rejects a retry receipt for another job without refreshing or clearing its failure', async () => {
  vi.mocked(request).mockResolvedValue({ status: 'retried', item: { id: 'other', status: 'pending' } });
  const refresh = vi.fn(async () => {});
  render(() => <NativeDownloads generation={1} disconnected={false} items={[{ id: 'job', status: 'failed', display_title: 'Song' }]} onChanged={refresh} />);
  fireEvent.click(screen.getByRole('button', { name: 'downloads.ariaRetry' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeVisible()); expect(refresh).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'downloads.ariaRetry' })).toBeEnabled();
});
