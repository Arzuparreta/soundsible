import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Migrate from './Migrate';
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
      }),
    );
    expect(await screen.findByText('Moving your music')).toBeInTheDocument();
  });
});
