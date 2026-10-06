import { beforeEach, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { setLocale } from '../lib/i18n';
import PodcastDirectory from './PodcastDirectory';
const mocks = vi.hoisted(() => ({ request: vi.fn(), menu: vi.fn() }));
vi.mock('../lib/contextMenu', () => ({ openContextMenu: mocks.menu }));
const searches = () => mocks.request.mock.calls.filter(([path]) => String(path).includes('/podcasts/search'));
vi.mock('../lib/http', () => ({ request: mocks.request }));
const row = { title: 'Show', feed_url: 'https://example.com/rss', author: 'Host' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { cleanup(); setLocale('en'); vi.clearAllMocks(); mocks.request.mockImplementation((path: string) => Promise.resolve(path.includes('recommendations') ? { items: [] } : { results: [row] })); });
it('opens a directory show without subscribing or creating audio', async () => {
  const open = vi.fn(); const view = render(() => <PodcastDirectory generation={1} onOpen={open} />);
  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'show' } }); await waitFor(() => expect(view.getByText('Show')).toBeTruthy());
  fireEvent.click(view.getByText('Show')); expect(open).toHaveBeenCalledWith({ title: 'Show', rss_url: row.feed_url, author: 'Host', image_url: undefined, itunes_collection_id: undefined });
  expect(searches()).toHaveLength(1);
});
it('discards stale directory results and aborts after an account change', async () => {
  const old = deferred<{ results: typeof row[] }>(); mocks.request.mockImplementation((path: string) => path.includes('recommendations') ? Promise.resolve({ items: [] }) : old.promise);
  const [generation, change] = createSignal(1); const view = render(() => <PodcastDirectory generation={generation()} onOpen={vi.fn()} />);
  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'old' } }); await waitFor(() => expect(searches()).toHaveLength(1));
  change(2); old.resolve({ results: [row] }); await Promise.resolve();
  expect(searches()[0][1].signal.aborted).toBe(true); expect(view.queryByText('Show')).toBeNull();
});
it('does not make directory requests while disconnected', async () => {
  const view = render(() => <PodcastDirectory generation={1} disconnected onOpen={vi.fn()} />);
  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'show' } }); await new Promise(resolve => setTimeout(resolve, 350)); expect(mocks.request).not.toHaveBeenCalled();
});
it('recommends top shows not yet followed, and their menu subscribes or sends "not interested"', async () => {
  const top = [{ title: 'Top show', feed_url: 'https://example.com/top', author: 'Host', recommendation_identity: 'rec-1', reason: 'Popular now' },
    { title: 'Followed show', rss_url: 'https://example.com/followed' }];
  mocks.request.mockImplementation((path: string) => Promise.resolve(path.includes('recommendations') ? { items: top } : { recorded: true, event_id: 'e1' }));
  const subscribe = vi.fn().mockResolvedValue(undefined), open = vi.fn();
  const view = render(() => <PodcastDirectory generation={1} onOpen={open} subscribed={feed => feed === 'https://example.com/followed'} onSubscribe={subscribe} />);
  await waitFor(() => expect(view.getByText('Top show')).toBeTruthy());
  expect(view.queryByText('Followed show')).toBeNull();
  fireEvent.click(view.getByText('Top show')); expect(open).toHaveBeenCalledWith(expect.objectContaining({ rss_url: 'https://example.com/top' }));
  fireEvent.contextMenu(view.getByText('Top show'));
  const actions = mocks.menu.mock.calls[0][0].actions;
  expect(actions.map((action: { label: string }) => action.label)).toEqual(['Subscribe', 'Popular now', 'Not interested']);
  actions[0].onSelect(); expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ rss_url: 'https://example.com/top', title: 'Top show' }));
  actions[2].onSelect(); await waitFor(() => expect(mocks.request.mock.calls.some(([path]) => path === '/api/discovery/feedback')).toBe(true));
  expect(mocks.request.mock.calls.find(([path]) => path === '/api/discovery/feedback')![1].body.item).toMatchObject({ media_type: 'podcast_show', podcast_feed_id: 'https://example.com/top' });
});
it('hides recommendations while searching and drops them on account change', async () => {
  mocks.request.mockImplementation((path: string) => Promise.resolve(path.includes('recommendations') ? { items: [{ title: 'Top show', feed_url: 'https://example.com/top' }] } : { results: [row] }));
  const [generation, change] = createSignal(1);
  const view = render(() => <PodcastDirectory generation={generation()} onOpen={vi.fn()} />);
  await waitFor(() => expect(view.getByText('Top show')).toBeTruthy());
  fireEvent.input(view.getByRole('searchbox'), { target: { value: 'show' } }); await waitFor(() => expect(view.getByText('Show')).toBeTruthy());
  expect(view.queryByText('Top show')).toBeNull();
  mocks.request.mockImplementation((path: string) => Promise.resolve(path.includes('recommendations') ? { items: [] } : { results: [] }));
  fireEvent.input(view.getByRole('searchbox'), { target: { value: '' } }); change(2);
  await waitFor(() => expect(mocks.request.mock.calls.filter(([path]) => String(path).includes('recommendations'))).toHaveLength(2));
  expect(view.queryByText('Top show')).toBeNull();
});
