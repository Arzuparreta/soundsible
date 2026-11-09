import type { Track } from '../types/music';
import { fireEvent, render, screen, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Search from './Search';
import { setLocale } from '../lib/i18n';
import { OverlayOutlet } from '../lib/overlay';
import { clearSearchCache } from '../lib/searchCache';

const apiMock = vi.hoisted(() => ({
  getDiscoveryMusicFeed: vi.fn(),
  searchCatalog: vi.fn(),
  suggest: vi.fn(),
  resolveCatalogItem: vi.fn(),
  saveCatalogItem: vi.fn(),
  prefetchPreviews: vi.fn(() => Promise.resolve({ status: 'queued' })),
}));

vi.mock('@solidjs/router', () => ({
  useNavigate: () => vi.fn(),
  useSearchParams: () => [{}, vi.fn()],
}));
vi.mock('../lib/api', () => ({ api: apiMock }));
vi.mock('../lib/toast', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
// The row's own menus are not under test: one button stands for its save.
vi.mock('../components/CatalogResultRow', () => ({
  CatalogResultRow: (props: { item: { title: string }; onDownload: () => void }) =>
    <button type="button" onClick={() => props.onDownload()}>Save {props.item.title}</button>,
}));
vi.mock('../components/NavigationMenu', () => ({ NavigationMenuButton: () => null }));
vi.mock('../stores', async () => {
  const { identityMock } = await import('../lib/identityMock');
  return {
    musicLibrary: () => [],
    actions: { playTrack: vi.fn(), loadDownloads: vi.fn(), linkCatalogItem: vi.fn() },
    state: { library: [], playback: { currentTrack: null, queue: [] }, autoMode: { active: false }, downloads: { queue: [] } },
    ...identityMock({ currentTrack: () => null, library: () => [] as Track[] }),
  };
});

beforeEach(() => {
  setLocale('en');
  clearSearchCache();
  vi.useFakeTimers();
  window.location.hash = '#/search';
  apiMock.getDiscoveryMusicFeed.mockResolvedValue({ items: [], browse_sections: [] });
  apiMock.suggest.mockResolvedValue([]);
  apiMock.resolveCatalogItem.mockResolvedValue({});
  apiMock.searchCatalog.mockResolvedValue({
    items: [{ id: 'deezer:track:1', type: 'track', source: 'deezer', title: 'Song', artist: 'Band' }],
    sections: [{ id: 'songs', layout: 'rows', item_ids: ['deezer:track:1'], total: 1 }],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('chooses between uploads in the shared overlay, with Escape and focus return, and saves the picked one', async () => {
  apiMock.saveCatalogItem
    .mockResolvedValueOnce({ status: 'needs_review', candidates: [
      { video_id: 'aaaaaaaaaaa', title: 'Song (Official)', channel: 'Band' },
      { video_id: 'bbbbbbbbbbb', title: 'Song (Live)', channel: 'Fan' },
    ] })
    .mockResolvedValueOnce({ status: 'needs_review', candidates: [{ video_id: 'bbbbbbbbbbb', title: 'Song (Live)', channel: 'Fan' }] })
    .mockResolvedValueOnce({ status: 'queued', video_id: 'bbbbbbbbbbb' });
  render(() => <><Search /><OverlayOutlet /></>);
  fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'song' } });
  await vi.advanceTimersByTimeAsync(230);
  const save = screen.getAllByRole('button', { name: 'Save Song' })[0];

  save.focus();
  fireEvent.click(save);
  await vi.advanceTimersByTimeAsync(0);
  const dialog = screen.getByRole('dialog', { name: 'Choose a version' });
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(within(dialog).getByText(/Song — Band/)).toBeInTheDocument();
  fireEvent.keyDown(window, { key: 'Escape' });
  await vi.advanceTimersByTimeAsync(0);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(document.activeElement).toBe(save);
  expect(apiMock.saveCatalogItem).toHaveBeenCalledTimes(1);

  fireEvent.click(save);
  await vi.advanceTimersByTimeAsync(0);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Song \(Live\)/ }));
  await vi.advanceTimersByTimeAsync(0);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(apiMock.saveCatalogItem).toHaveBeenLastCalledWith(expect.objectContaining({ confirm_video_id: 'bbbbbbbbbbb' }));
});
