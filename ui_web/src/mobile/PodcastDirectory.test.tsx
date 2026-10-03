import { beforeEach, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { setLocale } from '../lib/i18n';
import PodcastDirectory from './PodcastDirectory';
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../lib/http', () => ({ request: mocks.request }));
const row = { title: 'Show', feed_url: 'https://example.com/rss', author: 'Host' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { cleanup(); setLocale('en'); vi.clearAllMocks(); mocks.request.mockResolvedValue({ results: [row] }); });
it('opens a directory show without subscribing or creating audio', async () => {
  const open = vi.fn(); const view = render(() => <PodcastDirectory generation={1} onOpen={open} />);
  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'show' } }); await waitFor(() => expect(view.getByText('Show')).toBeTruthy());
  fireEvent.click(view.getByText('Show')); expect(open).toHaveBeenCalledWith({ title: 'Show', rss_url: row.feed_url, author: 'Host', image_url: undefined, itunes_collection_id: undefined });
  expect(mocks.request).toHaveBeenCalledTimes(1); expect(mocks.request.mock.calls[0][0]).toContain('/api/discovery/podcasts/search');
});
it('discards stale directory results and aborts after an account change', async () => {
  const old = deferred<{ results: typeof row[] }>(); mocks.request.mockReturnValue(old.promise);
  const [generation, change] = createSignal(1); const view = render(() => <PodcastDirectory generation={generation()} onOpen={vi.fn()} />);
  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'old' } }); await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
  change(2); old.resolve({ results: [row] }); await Promise.resolve();
  expect(mocks.request.mock.calls[0][1].signal.aborted).toBe(true); expect(view.queryByText('Show')).toBeNull();
});
it('does not make directory requests while disconnected', async () => {
  const view = render(() => <PodcastDirectory generation={1} disconnected onOpen={vi.fn()} />);
  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'show' } }); await new Promise(resolve => setTimeout(resolve, 350)); expect(mocks.request).not.toHaveBeenCalled();
});
