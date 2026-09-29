import { fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PodcastShow from './PodcastShow';
import { setLocale } from '../lib/i18n';

const apiMock = vi.hoisted(() => ({
  browsePodcastFeed: vi.fn(),
  getPodcastEpisodes: vi.fn(),
  unsubscribePodcast: vi.fn(),
}));
const routerMock = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  search: {} as Record<string, string>,
}));
const storeMock = vi.hoisted(() => ({
  state: { podcastSubscriptions: [] as Array<{ id: string; title: string; rss_url: string }>, library: [], downloads: { queue: [] } },
}));

vi.mock('@solidjs/router', () => ({
  useParams: () => routerMock.params,
  useSearchParams: () => [routerMock.search, vi.fn()],
  useNavigate: () => vi.fn(),
}));
vi.mock('../lib/api', () => ({ api: apiMock }));
vi.mock('../stores', () => ({
  state: storeMock.state,
  actions: { syncLibrary: vi.fn(), playTrack: vi.fn(), playEpisode: vi.fn(), downloadEpisode: vi.fn() },
  isPlayingEpisode: () => false,
}));
vi.mock('../lib/appBar', () => ({ useAppBar: vi.fn() }));
vi.mock('../lib/podcasts', () => ({ followPodcast: vi.fn(), shownPodcast: () => undefined }));
vi.mock('../lib/contextMenu', () => ({ openContextMenu: vi.fn() }));
vi.mock('../lib/toast', () => ({ toast: { error: vi.fn() } }));

const RSS = 'https://example.com/rss';
const episode = (n: number) => ({ guid: `ep${n}`, title: `Episode ${n}`, enclosure_url: `https://cdn.example.com/ep${n}.mp3` });
const LOAD_MORE = { name: 'Load more episodes' };

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

  it('offers nothing more when the whole feed was read', async () => {
    apiMock.browsePodcastFeed.mockResolvedValue({ episodes: [episode(1)], show: { title: 'My Show' }, next: null });
    render(() => <PodcastShow />);

    expect(await screen.findByText('Episode 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', LOAD_MORE)).not.toBeInTheDocument();
  });
});
