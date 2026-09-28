import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { beforeEach, expect, it, vi } from 'vitest';
import { useAlbumBookmarks } from './albumBookmarks';

const request = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ request }));
vi.mock('./session', () => ({ userKey: (key: string) => key }));
const album = { title: 'Record', artist: 'Band', deezerId: '42' };
function Harness() {
  const bookmarks = useAlbumBookmarks();
  return <>
    <button disabled={bookmarks.loading() || bookmarks.pending()} aria-pressed={!!bookmarks.find(album)}
      onClick={() => void bookmarks.toggle(album).catch(() => {})}>Toggle</button>
    <span>{bookmarks.error() ? 'Failed' : 'Ready'}</span>
  </>;
}
beforeEach(() => { request.mockReset(); });

it('persists add and remove, disabling repeated clicks while saving', async () => {
  let saved = false;
  request.mockImplementation(async (_path, options) => {
    if (options?.method === 'PUT') { saved = true; return {}; }
    if (options?.method === 'DELETE') { saved = false; return {}; }
    return { albums: saved ? [{ ...album, id: 'key' }] : [] };
  });
  render(Harness);
  const button = screen.getByRole('button');
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  expect(button).toBeDisabled();
  await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'true'));
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'false'));
  expect(request).toHaveBeenCalledWith('/api/album-bookmarks/key', { method: 'DELETE' });
});

it('does not claim a bookmark was saved after a failed write', async () => {
  request.mockImplementation(async (_path, options) => {
    if (options) throw new Error('offline');
    return { albums: [] };
  });
  render(Harness);
  const button = screen.getByRole('button');
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(button).toBeEnabled());
  expect(button).toHaveAttribute('aria-pressed', 'false');
});
