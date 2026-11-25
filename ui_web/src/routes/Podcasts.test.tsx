import { PageIndicator } from '../components/AppBar';
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JSX } from 'solid-js';
import Podcasts from './Podcasts';
import { setLocale } from '../lib/i18n';
import { setMediaQuery } from '../test-setup';

const apiMock = vi.hoisted(() => ({
  request: vi.fn(),
  subscribePodcast: vi.fn(),
  emitDiscoveryEvent: vi.fn(),
  sendDiscoveryFeedback: vi.fn(),
  undoDiscoveryFeedback: vi.fn(),
}));
const routerMock = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  setParams: vi.fn(),
}));

vi.mock('@solidjs/router', () => ({
  useNavigate: () => vi.fn(),
  useSearchParams: () => [routerMock.params, routerMock.setParams],
  A: (props: { href: string; children: JSX.Element }) => <a href={props.href}>{props.children}</a>,
}));
vi.mock('../lib/api', () => ({ api: apiMock }));
vi.mock('../lib/http', async importOriginal => ({ ...await importOriginal<typeof import('../lib/http')>(), request: apiMock.request }));
vi.mock('../lib/discover', () => ({
  ensureDiscover: vi.fn(),
  refreshDiscover: vi.fn(),
  topEpisodes: () => [], chartsCountry: () => undefined, chartFailed: () => false, episodesFailed: () => false,
  topPodcasts: () => [],
  revalidating: () => false,
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
    routerMock.params = {};
    apiMock.request.mockResolvedValue({ results: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('replaces completed rows with a loading state when the query changes', async () => {
    apiMock.request.mockResolvedValueOnce({ results: [
      { feed_url: 'first.xml', title: 'First show', author: 'First author' },
    ] });
    let resolveNext!: (value: unknown) => void;
    apiMock.request.mockImplementationOnce(
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
    expect(screen.queryByText('First show')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: /Loading/ })).toBeInTheDocument();

    resolveNext({ results: [{ feed_url: 'second.xml', title: 'Second show', author: 'Second author' }] });
    expect(await screen.findByText('Second show')).toBeInTheDocument();
    expect(screen.queryByText('First show')).not.toBeInTheDocument();
  });

  it('reconstructs the routed podcast query on mount', async () => {
    routerMock.params = { q: 'sound design' };
    render(() => <Podcasts />);

    await vi.advanceTimersByTimeAsync(310);
    expect(apiMock.request).toHaveBeenCalledWith(
      expect.stringContaining('q=sound+design'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByDisplayValue('sound design')).toBeInTheDocument();
  });

  it('does not let an aborted older request replace a newer result', async () => {
    let resolveOld!: (value: unknown) => void;
    let resolveNew!: (value: unknown) => void;
    apiMock.request
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));
    render(() => <Podcasts />);

    const input = screen.getByPlaceholderText(/Search podcasts/);
    fireEvent.input(input, { target: { value: 'older' } });
    await vi.advanceTimersByTimeAsync(310);
    fireEvent.input(input, { target: { value: 'newer' } });
    await vi.advanceTimersByTimeAsync(310);

    resolveOld({ results: [{ feed_url: 'old.xml', title: 'Old response', author: 'Old' }] });
    resolveNew({ results: [{ feed_url: 'new.xml', title: 'New response', author: 'New' }] });

    expect(await screen.findByText('New response')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Old response')).not.toBeInTheDocument());
  });
});

describe('Podcasts page header', () => {
  const DESKTOP = '(min-width: 1024px)';

  beforeEach(() => {
    setLocale('en');
    routerMock.params = {};
  });

  afterEach(() => {
    setMediaQuery(DESKTOP, false);
    vi.clearAllMocks();
  });

  it('titles the desktop page like every other root, keeping the country by the search', () => {
    setMediaQuery(DESKTOP, true);
    render(() => <><Podcasts /><PageIndicator /></>);

    const heading = screen.getByRole('heading', { level: 1, name: 'Podcasts' });
    const country = screen.getByRole('combobox', { name: 'Country for discovering podcasts' });
    expect(heading).toHaveAttribute('data-page-indicator');
    expect(heading).not.toContainElement(country);
    expect(country.closest('[data-page-toolbar]')).toContainElement(screen.getByPlaceholderText(/Search podcasts/));
    expect(screen.getAllByRole('combobox', { name: 'Country for discovering podcasts' })).toHaveLength(1);
  });

  it('keeps the country by the search on a phone', () => {
    render(() => <Podcasts />);

    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    const country = screen.getByRole('combobox', { name: 'Country for discovering podcasts' });
    expect(country.closest('[data-page-toolbar]')).toContainElement(screen.getByPlaceholderText(/Search podcasts/));
  });
});

// Navigation behavior is covered by the router integration and browser tests.
vi.mock('../components/NavigationMenu', () => ({ NavigationMenuButton: () => null }));
