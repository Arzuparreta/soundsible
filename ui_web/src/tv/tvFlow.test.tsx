import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockScrollportLayout } from '../testLayout';
import type { Track } from '../types/music';
import { resetTvState, setDimActive } from './state';

const mockApi = vi.hoisted(() => ({
  createTvAuthRequest: vi.fn(),
  getTvAuthStatus: vi.fn(),
  redeemTvAuthRequest: vi.fn(),
  cancelTvAuthRequest: vi.fn().mockResolvedValue({ status: 'cancelled' }),
  claimPairingSession: vi.fn(),
  getLibraryAlbums: vi.fn().mockResolvedValue([]),
  getLibraryAlbum: vi.fn(),
  getAlbumProfile: vi.fn(),
  searchCatalog: vi.fn().mockResolvedValue({ query: '', items: [], sections: [] }),
}));

const mockSession = vi.hoisted(() => ({
  refreshSession: vi.fn().mockResolvedValue({ requires_login: true, user: null }),
  login: vi.fn(),
  logout: vi.fn().mockResolvedValue(undefined),
  user: () => ({ id: 'u1', username: 'alice', display_name: 'Alice', role: 'member', has_password: true }),
  requiresLogin: () => true,
}));

const resumeBox = vi.hoisted(() => ({
  value: null as { device_id: string; device_name: string; track: Track } | null,
}));

const mockActions = vi.hoisted(() => ({
  playFrom: vi.fn(),
  playTrack: vi.fn(),
  resumePlayback: vi.fn(),
  pausePlayback: vi.fn(),
  resumeHere: vi.fn(),
  togglePlay: vi.fn(),
  prev: vi.fn(),
  next: vi.fn(),
  seek: vi.fn(),
  playQueueEntry: vi.fn(),
  setDeviceName: vi.fn(),
}));

const { mockState, setMockState } = vi.hoisted(() => ({
  mockState: {
    online: true,
    libraryReady: true,
    library: [] as Track[],
    playlists: {} as Record<string, string[]>,
    librarySettings: {},
    catalog: { artists: [], genres: [], years: [], ready: true, loading: false, revision: 1 },
    device: {
      device_id: 'tv-1',
      device_name: 'Living Room TV',
      device_type: 'web',
      form_factor: 'tv' as const,
      instance_id: 'inst-1',
      protocol: 1,
      commands: ['transport.play', 'transport.pause', 'transport.seek', 'queue.play_entry'],
    },
    playback: {
      currentTrack: null as Track | null,
      isPlaying: false,
      needsGesture: false,
      currentTime: 30,
      duration: 200,
      queue: [] as Array<Track & { queueId: string }>,
      index: 0,
    },
  },
  setMockState: {} as Record<string, unknown>,
}));
void setMockState;

const mockPlayCatalogItem = vi.hoisted(() => vi.fn());

vi.mock('../lib/catalogItem', () => ({
  playCatalogItem: mockPlayCatalogItem,
}));

vi.mock('../lib/api', () => ({
  api: mockApi,
  ApiError: class extends Error {
    constructor(readonly status: number, message: string, readonly code?: string) {
      super(message);
    }
  },
}));
vi.mock('../lib/session', () => mockSession);
vi.mock('../lib/vendor/qrcode.esm.js', () => ({
  default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,AA==') },
}));
vi.mock('../stores', () => ({
  state: mockState,
  actions: mockActions,
  musicLibrary: () => mockState.library,
  resumeState: () => resumeBox.value,
  isPlayingTrack: (t: Track) => mockState.playback.currentTrack?.id === t.id,
  isPlayingItem: () => false,
  initStore: vi.fn(),
  disposeStore: vi.fn(),
}));

import { TvFocusProvider } from './nav/spatial';
import { TvAlbumDetail } from './screens/TvAlbumDetail';
import { TvDimOverlay } from './screens/TvDimOverlay';
import { TvHome } from './screens/TvHome';
import { TvLibrary } from './screens/TvLibrary';
import { TvNowPlaying } from './screens/TvNowPlaying';
import { TvQueueOverlay } from './screens/TvQueueOverlay';
import { TvSignIn } from './screens/TvSignIn';
import { setLibraryTab } from './state';
import type { TvAction } from './nav/input';

afterEach(() => {
  cleanup();
  resetTvState();
  vi.clearAllMocks();
  vi.useRealTimers();
  resumeBox.value = null;
  mockState.playback.currentTrack = null;
  mockState.playback.isPlaying = false;
  mockState.playback.queue = [];
  mockState.playback.index = 0;
  mockState.library = [];
});

describe('Smart TV screen journeys', () => {
  it('polls with bounded backoff, redeems upon approval, and cancels on unmount', async () => {
    vi.useFakeTimers();
    mockApi.createTvAuthRequest.mockResolvedValue({
      code: 'ABCD-2345',
      redemption_handle: 'handle-1',
      device_name: 'Living Room TV',
      expires_at: '2099-01-01 00:00:00',
      expires_in_sec: 300,
      poll_interval_ms: 2000,
      approve_path: '/player/#/tv-approve',
      approve_url: 'http://station/player/#/tv-approve?code=ABCD-2345',
    });
    mockApi.getTvAuthStatus
      .mockResolvedValueOnce({ status: 'pending', device_name: 'Living Room TV', expires_at: '2099-01-01 00:00:00' })
      .mockResolvedValueOnce({ status: 'approved', device_name: 'Living Room TV', expires_at: '2099-01-01 00:00:00' });
    mockApi.redeemTvAuthRequest.mockResolvedValue({ user: mockSession.user(), device_name: 'Living Room TV' });

    const { getByTestId, unmount } = render(() => <TvSignIn />);
    await vi.advanceTimersByTimeAsync(10);
    expect(getByTestId('tv-auth-code')).toHaveTextContent('ABCD-2345');

    // First poll at 2000ms -> pending; second poll at +3000ms -> approved -> redeem.
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockApi.getTvAuthStatus).toHaveBeenCalledTimes(1);
    expect(mockApi.redeemTvAuthRequest).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(mockApi.getTvAuthStatus).toHaveBeenCalledTimes(2);
    expect(mockApi.redeemTvAuthRequest).toHaveBeenCalledWith('handle-1');
    expect(mockSession.refreshSession).toHaveBeenCalled();

    unmount();
    expect(mockApi.cancelTvAuthRequest).toHaveBeenCalledWith('handle-1');
  });

  it('never autoplays on Home and resumes with a single OK on the Resume hero', async () => {
    const track: Track = { id: 't-resume', title: 'Midnight City', artist: 'M83', duration: 243 };
    resumeBox.value = { device_id: 'phone-1', device_name: 'Phone', track };
    const onNavigate = vi.fn();

    const { getByText } = render(() => (
      <TvFocusProvider>
        <TvHome recentAlbums={[]} newestAlbums={[]} onNavigate={onNavigate} />
      </TvFocusProvider>
    ));

    await waitFor(() => expect(getByText('Midnight City')).toBeInTheDocument());
    expect(mockActions.resumeHere).not.toHaveBeenCalled();
    expect(mockActions.resumePlayback).not.toHaveBeenCalled();

    await fireEvent.click(getByText('Resume'));
    expect(mockActions.resumeHere).toHaveBeenCalledTimes(1);
  });

  it('supports seek preview/commit/cancel, Queue selection by queueId, and Dim wake restoration', async () => {
    const q0 = { id: 't1', title: 'First Track', artist: 'Artist A', duration: 200, queueId: 'qid-1' };
    const q1 = { id: 't2', title: 'Second Track', artist: 'Artist B', duration: 180, queueId: 'qid-2' };
    mockState.playback.currentTrack = q0;
    mockState.playback.currentTime = 30;
    mockState.playback.duration = 200;
    mockState.playback.queue = [q0, q1];
    mockState.playback.index = 0;

    const interceptorRef: { current: ((action: TvAction) => boolean) | null } = { current: null };
    mockScrollportLayout();
    const { getByRole, getByText, queryByText } = render(() => (
      <TvFocusProvider>
        <TvNowPlaying
          onNavigateHome={vi.fn()}
          registerActionInterceptor={(fn) => {
            interceptorRef.current = fn;
            return () => { interceptorRef.current = null; };
          }}
        />
        <TvQueueOverlay />
        <TvDimOverlay />
      </TvFocusProvider>
    ));

    const slider = getByRole('slider') as HTMLElement;
    slider.focus();
    await Promise.resolve();

    // Left/Right previews (+10s) without calling seek yet; Back cancels.
    expect(interceptorRef.current?.('right')).toBe(true);
    expect(mockActions.seek).not.toHaveBeenCalled();
    expect(getByText(/0:40/)).toBeInTheDocument();
    expect(interceptorRef.current?.('back')).toBe(true);
    expect(mockActions.seek).not.toHaveBeenCalled();

    // Right twice then OK commits seek to 50s.
    expect(interceptorRef.current?.('right')).toBe(true);
    expect(interceptorRef.current?.('right')).toBe(true);
    expect(interceptorRef.current?.('select')).toBe(true);
    expect(mockActions.seek).toHaveBeenCalledWith(50);

    // Open Queue overlay -> select second item by queueId without stopping playback.
    await fireEvent.click(getByText(/Queue/));
    expect(getByText('Up next')).toBeInTheDocument();
    await fireEvent.click(getByText('Second Track'));
    expect(mockActions.playQueueEntry).toHaveBeenCalledWith('qid-2');
    expect(queryByText('Up next')).toBeNull();

    // Activate Dim screen -> clicking/waking restores Dim off without navigating.
    const dimBtn = getByText(/Dim screen/);
    dimBtn.focus();
    await fireEvent.click(dimBtn);
    expect(getByText(/Listening on Soundsible TV/)).toBeInTheDocument();
    setDimActive(false);
    await Promise.resolve();
    expect(queryByText(/Listening on Soundsible TV/)).toBeNull();
  });

  it('prevents default on repeated Enter over focused buttons without blocking text inputs', async () => {
    mockApi.createTvAuthRequest.mockResolvedValue({
      code: 'ABCD-2345',
      redemption_handle: 'handle-1',
      device_name: 'Living Room TV',
      expires_at: '2099-01-01 00:00:00',
      expires_in_sec: 300,
      poll_interval_ms: 2000,
      approve_path: '/player/#/tv-approve',
      approve_url: 'http://station/player/#/tv-approve?code=ABCD-2345',
    });

    const { getByRole, unmount } = render(() => <TvSignIn />);
    await waitFor(() => expect(getByRole('button', { name: 'New code' })).toBeInTheDocument());

    const btn = getByRole('button', { name: 'New code' });
    btn.focus();
    const repeatEnterBtn = new KeyboardEvent('keydown', {
      key: 'Enter',
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    btn.dispatchEvent(repeatEnterBtn);
    expect(repeatEnterBtn.defaultPrevented).toBe(true);
    expect(mockApi.createTvAuthRequest).toHaveBeenCalledTimes(1);

    const roomInput = getByRole('textbox', { name: 'TV room name' });
    roomInput.focus();
    const repeatEnterInput = new KeyboardEvent('keydown', {
      key: 'Enter',
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    roomInput.dispatchEvent(repeatEnterInput);
    expect(repeatEnterInput.defaultPrevented).toBe(false);
    unmount();
  });

  it('retains loaded album pages across unmount and remount in TvLibrary', async () => {
    const allAlbums = Array.from({ length: 135 }, (_, i) => ({
      id: `alb-${i + 1}`,
      title: `Album ${String(i + 1).padStart(3, '0')}`,
      album_artist: `Artist ${i + 1}`,
      is_compilation: false,
      track_count: 8,
      duration: 1800,
    }));
    mockApi.getLibraryAlbums.mockImplementation(async (params?: { offset?: number; limit?: number }) => {
      const offset = params?.offset ?? 0;
      const limit = params?.limit ?? allAlbums.length;
      return allAlbums.slice(offset, offset + limit);
    });
    setLibraryTab('albums');

    const first = render(() => (
      <TvFocusProvider>
        <TvLibrary onNavigate={vi.fn()} />
      </TvFocusProvider>
    ));

    expect(await first.findByText('Album 001')).toBeInTheDocument();
    expect(first.queryByText('Album 125')).toBeNull();

    const loadMoreBtn = await first.findByRole('button', { name: 'Load more albums' });
    await fireEvent.click(loadMoreBtn);

    expect(await first.findByText('Album 135')).toBeInTheDocument();
    expect(first.queryByRole('button', { name: 'Load more albums' })).toBeNull();
    expect(mockApi.getLibraryAlbums).toHaveBeenCalledTimes(2);
    first.unmount();

    const second = render(() => (
      <TvFocusProvider>
        <TvLibrary onNavigate={vi.fn()} />
      </TvFocusProvider>
    ));
    expect(second.getByText('Album 135')).toBeInTheDocument();
    expect(second.queryByRole('button', { name: 'Load more albums' })).toBeNull();
    expect(mockApi.getLibraryAlbums).toHaveBeenCalledTimes(2);
  });

  it('preserves the full catalog tracklist in TvAlbumDetail even when a track exists locally', async () => {
    mockScrollportLayout();
    mockState.library = [
      {
        id: 'trk-local-1',
        title: 'One More Time',
        artist: 'Daft Punk',
        album: 'Discovery',
        album_artist: 'Daft Punk',
        duration: 320,
      },
    ];
    const catalogTracklist = [
      { id: 'dz-1', type: 'track' as const, source: 'deezer', title: 'One More Time', artist: 'Daft Punk', album: 'Discovery', track_id: 'trk-local-1', duration: 320 },
      { id: 'dz-2', type: 'track' as const, source: 'deezer', title: 'Aerodynamic', artist: 'Daft Punk', album: 'Discovery', duration: 212 },
      { id: 'dz-3', type: 'track' as const, source: 'deezer', title: 'Digital Love', artist: 'Daft Punk', album: 'Discovery', duration: 301 },
    ];
    mockApi.getAlbumProfile.mockResolvedValue({
      title: 'Discovery',
      artist: 'Daft Punk',
      tracklist: catalogTracklist,
    });

    const { findByText } = render(() => (
      <TvFocusProvider>
        <div data-tv-scroll-y="main">
          <TvAlbumDetail
            albumId="deezer:album:302127"
            albumName="Discovery"
            artist="Daft Punk"
            deezerId="302127"
            source="catalog"
            onBack={vi.fn()}
          />
        </div>
      </TvFocusProvider>
    ));

    expect(await findByText('One More Time')).toBeInTheDocument();
    expect(await findByText('Aerodynamic')).toBeInTheDocument();
    const thirdRow = await findByText('Digital Love');
    expect(thirdRow).toBeInTheDocument();
    expect(mockApi.getLibraryAlbum).not.toHaveBeenCalled();

    await fireEvent.click(thirdRow);
    expect(mockActions.playFrom).not.toHaveBeenCalled();
    expect(mockPlayCatalogItem).toHaveBeenCalledWith(
      catalogTracklist[2],
      catalogTracklist,
      expect.objectContaining({ id: 'album:deezer:album:302127', kind: 'album', label: 'Discovery' }),
    );
  });
});
