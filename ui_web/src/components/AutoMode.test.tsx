import { fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { actions, state } = vi.hoisted(() => ({
  actions: {
    setAutoProfile: vi.fn(),
    exitAutoMode: vi.fn(),
    setVolume: vi.fn(),
    autoSkip: vi.fn().mockResolvedValue(undefined),
    prev: vi.fn(),
    togglePlay: vi.fn(),
    downloadTrack: vi.fn(),
    toggleFavourite: vi.fn(),
    jumpTo: vi.fn(),
  },
  state: {
    favorites: [],
    playback: {
      currentTrack: { id: 'current', title: 'Current song', artist: 'Artist', cover: '/current.jpg' },
      queue: [
        { id: 'current', title: 'Current song', artist: 'Artist', cover: '/current.jpg' },
        { id: 'next', title: 'Next song', artist: 'Next artist', cover: '/next.jpg', source: 'preview' as const },
      ],
      index: 0,
      currentTime: 30,
      duration: 180,
      isPlaying: true,
      volume: 1,
    },
    autoMode: {
      active: true,
      profile: 'balanced' as const,
      phase: 'ready' as const,
      activity: {
        id: 1,
        status: 'done' as const,
        key: 'autoMode.agent.queued',
        values: { tracks: 'Next song', count: 1, related: 4, node: 3, local: 20 },
      },
      plan: {
        next: { trackId: 'next', source: 'related' as const, reasonKey: 'autoMode.reason.related', reasonValues: { title: 'Current song' } },
      },
    },
  },
}));

vi.mock('../stores', () => ({ actions, state }));
vi.mock('../lib/media', () => ({ coverUrl: (id: string) => `/cover/${id}` }));
vi.mock('../lib/i18n', () => ({
  t: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${Object.values(params).join(',')}` : key,
}));

import { AutoMode } from './AutoMode';

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('AutoMode environment', () => {
  it('renders playback, a concrete live action and a horizontally navigable queue', () => {
    render(() => <AutoMode />);

    expect(screen.getByRole('heading', { name: 'Current song' })).toBeInTheDocument();
    expect(screen.getByText('autoMode.agent.queued:Next song,1,4,3,20')).toBeInTheDocument();
    expect(screen.getByText('Next song')).toBeInTheDocument();

    const queue = screen.getByRole('button', { name: /Next song/ }).parentElement!;
    fireEvent.wheel(queue, { deltaY: 80, deltaX: 0 });
    expect(queue.scrollLeft).toBe(80);

    fireEvent.click(screen.getByRole('button', { name: 'autoMode.changeProfile:autoMode.profile.balanced' }));
    expect(actions.setAutoProfile).toHaveBeenCalledWith('explore');
    fireEvent.click(screen.getByRole('button', { name: 'autoMode.exit' }));
    expect(actions.exitAutoMode).toHaveBeenCalledOnce();
  });

  it('enters the ambient state after twelve idle seconds and wakes on input', async () => {
    vi.useFakeTimers();
    render(() => <AutoMode />);
    const root = screen.getByRole('region', { name: 'autoMode.aria' });
    const initialClass = root.className;

    await vi.advanceTimersByTimeAsync(12_000);
    expect(root.className).not.toBe(initialClass);

    fireEvent.pointerMove(root);
    expect(root.className).toBe(initialClass);
  });

  it('removes a completed agent report instead of keeping a status panel on screen', async () => {
    vi.useFakeTimers();
    render(() => <AutoMode />);
    expect(screen.getByText('autoMode.agent.queued:Next song,1,4,3,20')).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(6_000);
    expect(screen.queryByText('autoMode.agent.queued:Next song,1,4,3,20')).not.toBeInTheDocument();
  });
});
