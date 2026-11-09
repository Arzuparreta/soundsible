import { fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import PodcastShow from './PodcastShow';
import { setLocale } from '../lib/i18n';
import { openContextMenu } from '../lib/contextMenu';
import type { ActionMenuOptions } from '../components/ActionMenu';

const apiMock = vi.hoisted(() => ({
  browsePodcastFeed: vi.fn(),
  getPodcastEpisodes: vi.fn(),
  unsubscribePodcast: vi.fn(),
}));
const routerMock = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  search: {} as Record<string, string>,
  navigate: vi.fn(),
}));
const storeMock = vi.hoisted(() => ({
  state: {
    podcastSubscriptions: [] as Array<{ id: string; title: string; rss_url: string }>,
    library: [] as Array<Record<string, unknown>>,
    downloads: { queue: [] },
  },
  syncLibrary: vi.fn(),
}));
const toastMock = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock('@solidjs/router', () => ({
  useParams: () => routerMock.params,
  useSearchParams: () => [routerMock.search, vi.fn()],
  useNavigate: () => routerMock.navigate,
}));
vi.mock('../lib/api', () => ({ api: apiMock }));
vi.mock('../stores', () => ({
  state: storeMock.state,
  actions: { syncLibrary: storeMock.syncLibrary, playTrack: vi.fn(), playEpisode: vi.fn(), downloadEpisode: vi.fn() },
  isPlayingEpisode: () => false,
}));
vi.mock('../lib/appBar', () => ({ useAppBar: vi.fn() }));
vi.mock('../lib/podcasts', () => ({ followPodcast: vi.fn(), shownPodcast: () => undefined }));
vi.mock('../lib/contextMenu', () => ({ openContextMenu: vi.fn() }));
vi.mock('../lib/toast', () => ({ toast: toastMock }));

const RSS = 'https://example.com/rss';
const episode = (n: number) => ({ guid: `ep${n}`, title: `Episode ${n}`, enclosure_url: `https://cdn.example.com/ep${n}.mp3` });
const LOAD_MORE = { name: 'Load more episodes' };
function selectShowAction(label: string) {
  fireEvent.click(screen.getByRole('button', { name: 'More options' }));
  const menu = vi.mocked(openContextMenu).mock.calls.at(-1)?.[0] as ActionMenuOptions;
  const action = menu.actions?.find(item => item.label === label);
  expect(action).toBeDefined();
  if (!action?.disabled) action?.onSelect();
  return action;
}

beforeAll(() => {
  // jsdom reports every element as zero-sized, so the virtual list would
  // decide nothing fits and render no episodes at all.
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 400 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
});

describe('PodcastShow feed too long to read at once (#250)', () => {
  beforeEach(() => {
    setLocale('en');
    routerMock.params = {};
    routerMock.search = { url: RSS };
    storeMock.state.podcastSubscriptions = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads the rest of the feed a page at a time, only when asked', async () => {
    apiMock.browsePodcastFeed
      .mockResolvedValueOnce({ episodes: [episode(1), episode(2)], show: { title: 'My Show' }, next: 2 })
      .mockResolvedValueOnce({ episodes: [episode(3)], next: 3 })
      .mockResolvedValueOnce({ episodes: [episode(4)], next: null });
    render(() => <PodcastShow />);

    expect(await screen.findByText('Episode 2')).toBeInTheDocument();
    expect(apiMock.browsePodcastFeed).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', LOAD_MORE));
    expect(await screen.findByText('Episode 3')).toBeInTheDocument();
    expect(apiMock.browsePodcastFeed).toHaveBeenLastCalledWith(RSS, 2);

    fireEvent.click(screen.getByRole('button', LOAD_MORE));
    expect(await screen.findByText('Episode 4')).toBeInTheDocument();
    expect(apiMock.browsePodcastFeed).toHaveBeenLastCalledWith(RSS, 3);
    expect(screen.queryByRole('button', LOAD_MORE)).not.toBeInTheDocument();
  });

  it('continues a followed show from its cached list without listing an episode twice', async () => {
    routerMock.params = { id: 'feed' };
    routerMock.search = {};
    storeMock.state.podcastSubscriptions = [{ id: 'feed', title: 'My Show', rss_url: RSS }];
    apiMock.getPodcastEpisodes.mockResolvedValue({ episodes: [episode(1), episode(2)], next: 2 });
    apiMock.browsePodcastFeed.mockResolvedValue({ episodes: [episode(2), episode(3)], next: null });
    render(() => <PodcastShow />);

    expect(await screen.findByText('Episode 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', LOAD_MORE));

    expect(await screen.findByText('Episode 3')).toBeInTheDocument();
    expect(apiMock.browsePodcastFeed).toHaveBeenCalledWith(RSS, 2);
    expect(screen.getAllByText('Episode 2')).toHaveLength(1);
  });

  it('builds only the rows in view, so it does not download every cover at once', async () => {
    // Every row carries its own artwork as a background image, which the
    // browser fetches as soon as the row exists. A whole feed's worth of rows
    // was over a gigabyte of covers that starved playback for minutes.
    const episodes = Array.from({ length: 2000 }, (_, n) => ({ ...episode(n + 1), image: `https://cdn.example.com/${n + 1}.jpg` }));
    apiMock.browsePodcastFeed.mockResolvedValue({ episodes, show: { title: 'My Show' }, next: 2000 });
    const { container } = render(() => <PodcastShow />);

    expect(await screen.findByText('Episode 1')).toBeInTheDocument();
    const rows = container.querySelectorAll('[data-index]');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(60);
    expect(container.innerHTML).not.toContain('https://cdn.example.com/2000.jpg');
    expect(screen.getByRole('button', LOAD_MORE)).toBeInTheDocument();
  });

  it('offers nothing more when the whole feed was read', async () => {
    apiMock.browsePodcastFeed.mockResolvedValue({ episodes: [episode(1)], show: { title: 'My Show' }, next: null });
    render(() => <PodcastShow />);

    expect(await screen.findByText('Episode 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', LOAD_MORE)).not.toBeInTheDocument();
  });
});

describe('PodcastShow header', () => {
  beforeEach(() => {
    setLocale('en');
    routerMock.params = { id: 'feed' };
    routerMock.search = {};
    storeMock.state.podcastSubscriptions = [{ id: 'feed', title: 'A Show With A Name Far Too Long To Fit Anywhere', rss_url: RSS }];
    storeMock.state.library = [];
    apiMock.getPodcastEpisodes.mockResolvedValue({ episodes: [episode(1), episode(2)], next: null });
  });

  afterEach(() => {
    vi.clearAllMocks();
    apiMock.unsubscribePodcast.mockReset();
  });

  it('names the show in full as the page heading', async () => {
    render(() => <PodcastShow />);
    expect(await screen.findByRole('heading', { level: 1, name: 'A Show With A Name Far Too Long To Fit Anywhere' })).toBeInTheDocument();
  });

  it('stays on a show it could not unfollow and says so', async () => {
    let fail!: (error: Error) => void;
    apiMock.unsubscribePodcast.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    render(() => <PodcastShow />);
    await screen.findByText('Episode 1');

    selectShowAction('Unfollow');
    expect(screen.getByRole('button', { name: 'More options' })).toHaveAttribute('aria-busy', 'true');
    expect(selectShowAction('Unfollowing…')).toHaveProperty('disabled', true);
    expect(apiMock.unsubscribePodcast).toHaveBeenCalledOnce();

    fail(new Error('offline'));
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'More options' })).not.toHaveAttribute('aria-busy'));
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    expect(vi.mocked(openContextMenu).mock.calls.at(-1)?.[0].actions?.find(item => item.label === 'Unfollow')).toHaveProperty('disabled', false);
    expect(toastMock.error).toHaveBeenCalledWith('Could not update the subscription. Check your podcasts and try again.');
    expect(storeMock.syncLibrary).not.toHaveBeenCalled();
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  it('leaves the page only once the engine confirmed the unfollow', async () => {
    apiMock.unsubscribePodcast.mockResolvedValue(undefined);
    storeMock.syncLibrary.mockResolvedValue(undefined);
    render(() => <PodcastShow />);
    await screen.findByText('Episode 1');

    selectShowAction('Unfollow');

    await vi.waitFor(() => expect(routerMock.navigate).toHaveBeenCalledWith('/podcasts', { replace: true }));
    expect(apiMock.unsubscribePodcast).toHaveBeenCalledWith('feed');
    expect(storeMock.syncLibrary).toHaveBeenCalledOnce();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('reports a failed unfollow after leaving without navigating the new page', async () => {
    let fail!: (error: Error) => void;
    apiMock.unsubscribePodcast.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    const view = render(() => <PodcastShow />);
    await screen.findByText('Episode 1');
    selectShowAction('Unfollow');
    view.unmount();
    fail(new Error('offline'));
    await vi.waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Could not update the subscription. Check your podcasts and try again.'));
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  it('announces the downloaded filter and undoes it from an emptied list', async () => {
    render(() => <PodcastShow />);
    await screen.findByText('Episode 1');
    const filter = screen.getByRole('button', { name: 'Downloaded only' });
    expect(filter).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(filter);
    expect(filter).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Episode 1')).not.toBeInTheDocument();
    expect(screen.getByText('No downloaded episodes of this show.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show all episodes' }));
    expect(filter).toHaveAttribute('aria-pressed', 'false');
    expect(await screen.findByText('Episode 1')).toBeInTheDocument();
  });
  it('keeps refresh reachable in the show menu without a second toolbar', async () => {
    const { container } = render(() => <PodcastShow />);
    await screen.findByText('Episode 1');
    expect(container.querySelectorAll('[data-entity-toolbar]')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Unfollow' })).not.toBeInTheDocument();
    const before = apiMock.getPodcastEpisodes.mock.calls.length;
    selectShowAction('Refresh episodes');
    await vi.waitFor(() => expect(apiMock.getPodcastEpisodes).toHaveBeenCalledWith('feed', 'refresh'));
    expect(apiMock.getPodcastEpisodes.mock.calls.length).toBe(before + 1);
  });
});
