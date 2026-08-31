import { render, screen } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemotePlaybackState } from '../lib/api';
import { buildPlaybackSession } from '../lib/playbackSession';
import type { AutoModeState } from '../lib/generatedQueue';
import type { PlaybackQueueEntry } from '../lib/playbackQueue';

const store = vi.hoisted(() => ({ offered: null as unknown }));
vi.mock('../stores', () => ({
  resumeState: () => store.offered,
  actions: { resumeHere: vi.fn(), dismissResume: vi.fn() },
}));

import { ResumeBanner } from './ResumeBanner';

const entry: PlaybackQueueEntry = {
  id: 't1',
  title: 'Hyperballad',
  artist: 'Björk',
  queueId: 'q1',
  queueLane: 'generated',
  queueSource: 'auto_mode',
};

const auto: AutoModeState = {
  active: true,
  profile: 'balanced',
  djProfile: 'adaptive',
  direction: { energy: 0, familiarity: 0, prompt: '', include: [], exclude: [] },
  sources: [],
  heard: [],
  avoidedIdentities: [],
  transition: { status: 'idle' },
  pendingDirection: false,
  repairing: false,
  phase: 'ready',
  activity: null,
  plan: {},
  staleSeams: [],
};

function offer(active: boolean): RemotePlaybackState {
  return {
    device_id: 'dev2',
    device_name: 'Phone',
    track_id: 't1',
    track: entry,
    position_sec: 30,
    session: buildPlaybackSession({
      queue: [entry],
      index: 0,
      shuffle: false,
      repeat: 'off',
      radioMode: false,
      radioSeedId: null,
      auto: { ...auto, active },
    }),
  };
}

beforeEach(() => {
  store.offered = null;
});

describe('resume banner', () => {
  it('offers a DJ session as the DJ session it is', () => {
    store.offered = offer(true);

    render(() => <ResumeBanner />);

    expect(screen.getByText('Resume your DJ session?')).toBeVisible();
    expect(screen.getByText(/DJ session · from Phone/)).toBeVisible();
  });

  it('offers ordinary playback as ordinary playback', () => {
    store.offered = offer(false);

    render(() => <ResumeBanner />);

    expect(screen.getByText('Resume playback?')).toBeVisible();
    expect(screen.queryByText(/DJ session/)).not.toBeInTheDocument();
  });

  it('still offers a state published without a session at all', () => {
    store.offered = { device_name: 'Phone', track_id: 't1', track: entry, position_sec: 30 };

    render(() => <ResumeBanner />);

    expect(screen.getByText('Resume playback?')).toBeVisible();
    expect(screen.getByText(/Hyperballad/)).toBeVisible();
  });
});
