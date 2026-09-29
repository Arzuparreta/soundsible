import { render, screen } from '@solidjs/testing-library';
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

vi.mock('@solidjs/router', () => ({
  useParams: () => routerMock.params,
  useSearchParams: () => [routerMock.search, vi.fn()],
  useNavigate: () => vi.fn(),
}));
vi.mock('../lib/api', () => ({ api: apiMock }));
vi.mock('../stores', () => ({
  state: { podcastSubscriptions: [], library: [], downloads: { queue: [] } },
  actions: { syncLibrary: vi.fn(), playTrack: vi.fn(), playEpisode: vi.fn(), downloadEpisode: vi.fn() },
  isPlayingEpisode: () => false,
}));
vi.mock('../lib/appBar', () => ({ useAppBar: vi.fn() }));
vi.mock('../lib/podcasts', () => ({ followPodcast: vi.fn(), shownPodcast: () => undefined }));
vi.mock('../lib/contextMenu', () => ({ openContextMenu: vi.fn() }));
vi.mock('../lib/toast', () => ({ toast: { error: vi.fn() } }));

const EPISODE = { guid: 'ep1', title: 'Week 3 Studs & Duds', enclosure_url: 'https://cdn.example.com/ep1.mp3' };
const NOTE = /too large to load in full/;

describe('PodcastShow feed that could not be read whole', () => {
  beforeEach(() => {
    setLocale('en');
    routerMock.params = {};
    routerMock.search = { url: 'https://example.com/rss' };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('says the list stops short when the feed was too large (#250)', async () => {
    apiMock.browsePodcastFeed.mockResolvedValue({ episodes: [EPISODE], show: { title: 'My Show' }, partial: true });
    render(() => <PodcastShow />);

    expect(await screen.findByText(EPISODE.title)).toBeInTheDocument();
    expect(screen.getByText(NOTE)).toBeInTheDocument();
  });

  it('keeps the note for a followed show whose cached list is partial', async () => {
    routerMock.params = { id: 'feed' };
    routerMock.search = {};
    apiMock.getPodcastEpisodes.mockResolvedValue({ episodes: [EPISODE], partial: true });
    render(() => <PodcastShow />);

    expect(await screen.findByText(EPISODE.title)).toBeInTheDocument();
    expect(screen.getByText(NOTE)).toBeInTheDocument();
  });

  it('says nothing when the whole feed was read', async () => {
    apiMock.browsePodcastFeed.mockResolvedValue({ episodes: [EPISODE], show: { title: 'My Show' }, partial: false });
    render(() => <PodcastShow />);

    expect(await screen.findByText(EPISODE.title)).toBeInTheDocument();
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });
});
