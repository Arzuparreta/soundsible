import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JSX } from 'solid-js';
import Podcasts from './Podcasts';
import { setLocale } from '../lib/i18n';

const apiMock = vi.hoisted(() => ({
  searchPodcasts: vi.fn(),
  subscribePodcast: vi.fn(),
  emitDiscoveryEvent: vi.fn(),
  sendDiscoveryFeedback: vi.fn(),
  undoDiscoveryFeedback: vi.fn(),
}));

vi.mock('@solidjs/router', () => ({
  useNavigate: () => vi.fn(),
  A: (props: { href: string; children: JSX.Element }) => <a href={props.href}>{props.children}</a>,
}));
vi.mock('../lib/api', () => ({ api: apiMock }));
vi.mock('../lib/discover', () => ({
  ensureDiscover: vi.fn(),
  topPodcasts: () => [],
}));
vi.mock('../stores', () => ({
  state: { podcastSubscriptions: [] },
  actions: { syncLibrary: vi.fn() },
}));
vi.mock('../lib/contextMenu', () => ({ attachContextMenu: vi.fn() }));
vi.mock('../lib/toast', () => ({
  toast: { action: vi.fn(), error: vi.fn() },
}));

describe('Podcasts route search state', () => {
  beforeEach(() => {
    setLocale('en');
    vi.useFakeTimers();
    apiMock.searchPodcasts.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('retains completed rows as inert feedback until the next query resolves', async () => {
    apiMock.searchPodcasts.mockResolvedValueOnce([
      { feed_url: 'first.xml', title: 'First show', author: 'First author' },
    ]);
    let resolveNext!: (value: unknown) => void;
    apiMock.searchPodcasts.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveNext = resolve;
      }),
    );
    render(() => <Podcasts />);

    const input = screen.getByPlaceholderText(/Search podcasts/);
    fireEvent.input(input, { target: { value: 'first' } });
    await vi.advanceTimersByTimeAsync(310);
    expect(await screen.findByText('First show')).toBeInTheDocument();

    fireEvent.input(input, { target: { value: 'second' } });
    await vi.advanceTimersByTimeAsync(310);
    expect(screen.getByText('First show').closest('[aria-busy="true"]')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('status', { name: /Loading/ })).toBeInTheDocument();

    resolveNext([{ feed_url: 'second.xml', title: 'Second show', author: 'Second author' }]);
    expect(await screen.findByText('Second show')).toBeInTheDocument();
    expect(screen.queryByText('First show')).not.toBeInTheDocument();
  });

  it('does not let an aborted older request replace a newer result', async () => {
    let resolveOld!: (value: unknown) => void;
    let resolveNew!: (value: unknown) => void;
    apiMock.searchPodcasts
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));
    render(() => <Podcasts />);

    const input = screen.getByPlaceholderText(/Search podcasts/);
    fireEvent.input(input, { target: { value: 'older' } });
    await vi.advanceTimersByTimeAsync(310);
    fireEvent.input(input, { target: { value: 'newer' } });
    await vi.advanceTimersByTimeAsync(310);

    resolveOld([{ feed_url: 'old.xml', title: 'Old response', author: 'Old' }]);
    resolveNew([{ feed_url: 'new.xml', title: 'New response', author: 'New' }]);

    expect(await screen.findByText('New response')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Old response')).not.toBeInTheDocument());
  });
});
