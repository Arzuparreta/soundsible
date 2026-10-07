import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import Migrate from './Migrate';
import { MigrateView } from './MigrateView';
import { setLocale } from '../lib/i18n';
import type { MigrationJob } from '../lib/migrationApi';

const apiMock = vi.hoisted(() => ({
  upload: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  start: vi.fn(),
  control: vi.fn(),
  decide: vi.fn(),
}));

vi.mock('@solidjs/router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../lib/migrationApi', async (original) => {
  const actual = await original<typeof import('../lib/migrationApi')>();
  return { ...actual, migrationApi: apiMock };
});
vi.mock('../lib/toast', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

function analyzedJob(): MigrationJob {
  return {
    id: 'job-1',
    provider: 'spotify',
    source_name: 'Playlist1',
    state: 'analyzed',
    manifest: {
      track_count: 3,
      library_count: 1,
      favourite_count: 1,
      warnings: [],
      playlists: [
        {
          source_id: 'road',
          name: 'Road trip',
          track_count: 2,
          track_keys: ['spotify:a', 'spotify:b'],
          is_favourites: false,
        },
        {
          source_id: 'liked',
          name: 'Liked Songs',
          track_count: 1,
          track_keys: ['spotify:c'],
          is_favourites: true,
        },
      ],
    },
    selection: {},
    playlist_names: {},
    counts: { existing: 1, pending: 2 },
    selected_counts: {},
    selected_track_count: 3,
    estimated_download_bytes: 8_000_000,
    tracks: [
      {
        source_key: 'spotify:a',
        source: { title: 'Alpha', artist: 'Artist', album: 'Album' },
        state: 'existing',
        confidence: 1,
        candidates: [],
      },
      {
        source_key: 'spotify:b',
        source: { title: 'Beta', artist: 'Artist', album: 'Album' },
        state: 'pending',
        confidence: 0,
        candidates: [],
      },
      {
        source_key: 'spotify:c',
        source: { title: 'Gamma', artist: 'Artist', album: 'Album' },
        state: 'pending',
        confidence: 0,
        candidates: [],
      },
    ],
  };
}

describe('Migrate route', () => {
  beforeEach(() => {
    setLocale('en');
    window.localStorage.removeItem('soundsible.migration-guide');
    apiMock.list.mockReset().mockResolvedValue({ jobs: [] });
    apiMock.get.mockReset();
    apiMock.upload.mockReset();
    apiMock.start.mockReset();
  });

  it('starts with a plain service choice and no file-format jargon', async () => {
    render(() => <Migrate />);

    expect(await screen.findByText('Where is your music now?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Spotify/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apple Music/ })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\b(?:ZIP|JSON|XML|CSV)\b/);
  });

  it('guides Spotify users to the official request and remembers the waiting step', async () => {
    const first = render(() => <Migrate />);
    await fireEvent.click(await screen.findByRole('button', { name: /Spotify/ }));

    expect(screen.getByText('Ask Spotify for your account data')).toBeInTheDocument();
    expect(screen.getByText('Choose the file Spotify sent you')).toBeInTheDocument();
    const spotifyLink = screen.getByRole('link', { name: /Open Spotify/ });
    expect(spotifyLink).toHaveAttribute('href', 'https://www.spotify.com/account/privacy/');
    await fireEvent.click(spotifyLink);
    expect(screen.getByText('Waiting for Spotify?')).toBeInTheDocument();
    first.unmount();

    render(() => <Migrate />);
    expect(await screen.findByText('Waiting for Spotify?')).toBeInTheDocument();
    expect(screen.getByText('Choose the file Spotify sent you')).toBeInTheDocument();
  });

  it('shows honest Apple guidance for Mac, Windows and mobile', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(() => <Migrate />);
    await fireEvent.click(await screen.findByRole('button', { name: /Apple Music/ }));

    expect(screen.getByText('Open Music on your Mac')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Windows' }));
    expect(screen.getByText('Open iTunes on your PC')).toBeInTheDocument();
    expect(screen.getByText(/not the newer Apple Music app/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Phone or tablet' }));
    expect(screen.getByText('Continue on a computer')).toBeInTheDocument();
    expect(screen.queryByText('Choose the Apple Music file')).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Copy address' }));
    expect(writeText).toHaveBeenCalledWith(window.location.href);
  });

  it('restores an unfinished import without sending the user through the guide again', async () => {
    const running = {
      ...analyzedJob(),
      state: 'running' as const,
      selection: { include_library: true, playlist_ids: ['road'] },
    };
    apiMock.list.mockResolvedValue({ jobs: [{ id: 'job-1', state: 'running' }] });
    apiMock.get.mockResolvedValue({ job: running });

    render(() => <Migrate />);

    expect(await screen.findByText('Moving your music')).toBeInTheDocument();
    expect(screen.queryByText('Where is your music now?')).not.toBeInTheDocument();
  });

  it('ships the migration guide in French instead of falling back to English', async () => {
    setLocale('fr');
    render(() => <Migrate />);

    expect(await screen.findByText('Où se trouve votre musique actuellement ?')).toBeInTheDocument();
    expect(screen.queryByText('Where is your music now?')).not.toBeInTheDocument();
  });

  it('accepts one official export and offers library plus playlist selection', async () => {
    apiMock.upload.mockResolvedValue({ job: analyzedJob(), created: true });
    render(() => <Migrate />);
    await fireEvent.click(await screen.findByRole('button', { name: /Spotify/ }));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['{}'], 'Playlist1.json', { type: 'application/json' });
    await fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText('Ready to move')).toBeInTheDocument();
    expect(screen.getByText('Road trip')).toBeInTheDocument();
    expect(screen.getByText(/1 liked songs will stay favourites/)).toBeInTheDocument();
    expect(screen.queryByText('Liked Songs')).not.toBeInTheDocument();
  });

  it('sends the selected scope and starts the durable job', async () => {
    const analyzed = analyzedJob();
    const running = { ...analyzed, state: 'running' as const, selection: { include_library: true, playlist_ids: ['road'] } };
    apiMock.upload.mockResolvedValue({ job: analyzed, created: true });
    apiMock.start.mockResolvedValue({ job: running });
    render(() => <Migrate />);
    await fireEvent.click(await screen.findByRole('button', { name: /Spotify/ }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await fireEvent.change(input, {
      target: { files: [new File(['{}'], 'Playlist1.json', { type: 'application/json' })] },
    });
    await fireEvent.click(await screen.findByRole('button', { name: 'Start import' }));

    await waitFor(() =>
      expect(apiMock.start).toHaveBeenCalledWith('job-1', {
        include_library: true,
        playlist_ids: ['road'],
      }, { signal: expect.any(AbortSignal) }),
    );
    expect(await screen.findByText('Moving your music')).toBeInTheDocument();
  });
  it('keeps the guide after cancelling the OS picker, without a web file input', async () => {
    const choose = vi.fn().mockResolvedValue(undefined);
    render(() => <MigrateView compact onOpenPlaylists={() => {}} chooseUpload={choose} />);
    await fireEvent.click(await screen.findByRole('button', { name: /Spotify/ }));
    const button = document.querySelector('[data-native-import-select]') as HTMLButtonElement;
    expect(document.querySelector('input[type=file]')).toBeNull();
    await fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(choose).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(screen.getByText('Choose the file Spotify sent you')).toBeInTheDocument();
    expect(apiMock.upload).not.toHaveBeenCalled();
  });

  it('aborts a selected export when its view closes and ignores the late job', async () => {
    let resolve!: (value: {job: MigrationJob; created: boolean}) => void;
    const choose = vi.fn((_signal: AbortSignal) => new Promise<{job: MigrationJob; created: boolean}>(done => { resolve = done; }));
    const view = render(() => <MigrateView compact onOpenPlaylists={() => {}} chooseUpload={choose} />);
    await fireEvent.click(await screen.findByRole('button', { name: /Spotify/ }));
    await fireEvent.click(document.querySelector('[data-native-import-select]')!);
    const signal = choose.mock.calls[0][0] as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    resolve({ job: analyzedJob(), created: true });
    await Promise.resolve();
    expect(localStorage.getItem('soundsible.migration-guide')).toContain('spotify');
  });

  it('keeps a confirmed pause when an older progress poll arrives late', async () => {
    const running = { ...analyzedJob(), state: 'running' as const };
    const paused = { ...running, state: 'paused' as const };
    apiMock.list.mockResolvedValue({ jobs: [running] });
    apiMock.get.mockResolvedValueOnce({ job: running });
    let poll!: () => Promise<void>;
    const interval = vi.spyOn(window, 'setInterval').mockImplementation(callback => { poll = callback as () => Promise<void>; return 100 as unknown as ReturnType<typeof window.setInterval>; });
    try {
      render(() => <MigrateView compact onOpenPlaylists={() => {}} />);
      await screen.findByRole('button', { name: 'Pause' });
      let finish!: (value: {job: MigrationJob}) => void;
      apiMock.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const inFlight = poll();
      apiMock.control.mockResolvedValueOnce({ job: paused });
      await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
      await screen.findByRole('button', { name: 'Resume' });
      finish({ job: running }); await inFlight;
      expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    } finally { interval.mockRestore(); }
  });

  it('never reuses an invalidated account lifetime even if the view remains mounted', async () => {
    const [current, setCurrent] = createSignal(true);
    const choose = vi.fn().mockResolvedValue(undefined);
    render(() => <MigrateView compact current={current} onOpenPlaylists={() => {}} chooseUpload={choose} />);
    await fireEvent.click(await screen.findByRole('button', { name: /Spotify/ }));
    setCurrent(false); setCurrent(true);
    await fireEvent.click(document.querySelector('[data-native-import-select]')!);
    expect(choose).not.toHaveBeenCalled();
  });

});

vi.mock('../components/NavigationMenu', () => ({ NavigationMenuButton: () => null }));
