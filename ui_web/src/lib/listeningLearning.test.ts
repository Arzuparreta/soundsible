import { describe, expect, it, vi } from 'vitest';
import { ListeningLearning } from './listeningLearning';
import type { Track } from '../types/music';

const music: Track = {
  id: 'track-1',
  title: 'Song',
  artist: 'Artist',
  youtube_id: 'abcdefghijk',
};
const generated: Track = {
  ...music,
  recommendation: {
    identity: 'music:youtube:abcdefghijk',
    source: 'auto_mode',
  },
  duration: 180,
};

describe('ListeningLearning', () => {
  it('emits once after 30 seconds of real forward playback', () => {
    const emit = vi.fn();
    const learning = new ListeningLearning(emit, 30);
    learning.update(music, 0, true);
    for (let second = 1; second <= 35; second += 1) learning.update(music, second, true);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      'music_played_30s',
      expect.objectContaining({ youtube_id: 'abcdefghijk', title: 'Song' }),
    );
  });

  it('does not count pauses or seek jumps', () => {
    const emit = vi.fn();
    const learning = new ListeningLearning(emit, 5);
    learning.update(music, 0, true);
    learning.update(music, 1, true);
    learning.update(music, 20, true);
    learning.update(music, 21, false);
    learning.update(music, 22, true);
    learning.update(music, 23, true);

    expect(emit).not.toHaveBeenCalled();
  });

  it('resets the threshold for a new track', () => {
    const emit = vi.fn();
    const learning = new ListeningLearning(emit, 3);
    learning.update(music, 0, true);
    learning.update(music, 1, true);
    learning.update({ ...music, id: 'track-2' }, 0, true);
    learning.update({ ...music, id: 'track-2' }, 1, true);
    learning.update({ ...music, id: 'track-2' }, 2, true);
    learning.update({ ...music, id: 'track-2' }, 3, true);

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('records a generated completion without turning 30 seconds into completion', () => {
    const emit = vi.fn();
    const learning = new ListeningLearning(emit, 30);
    learning.update(generated, 0, true);
    for (let second = 1; second <= 65; second += 1) learning.update(generated, second, true);
    learning.complete(generated, 180);

    expect(emit).toHaveBeenCalledWith('music_played_30s', expect.objectContaining({ source: 'auto_mode' }));
    expect(emit).toHaveBeenCalledWith(
      'music_generated_completed',
      expect.objectContaining({ source: 'auto_mode' }),
    );
  });

  it('records non-generated completion and early skip with shared play_session_id', () => {
    const emit = vi.fn();
    const learning = new ListeningLearning(emit, 30);
    const searchTrack: Track = { ...music, duration: 100, queueSource: 'search' } as Track & { queueSource: string };
    learning.update(searchTrack, 0, true);
    for (let second = 1; second <= 75; second += 1) learning.update(searchTrack, second, true);
    learning.complete(searchTrack, 100);

    expect(emit).toHaveBeenCalledWith(
      'music_played_30s',
      expect.objectContaining({ source: 'search', play_session_id: expect.any(String) }),
    );
    expect(emit).toHaveBeenCalledWith(
      'music_play_completed',
      expect.objectContaining({ source: 'search', play_session_id: emit.mock.calls[0][1].play_session_id }),
    );

    const emitSkip = vi.fn();
    const skipLearning = new ListeningLearning(emitSkip, 30);
    const discoverTrack: Track = {
      ...music,
      id: 'track-disc',
      duration: 180,
      recommendation: { identity: 'music:deezer:1', source: 'discover' },
    };
    skipLearning.update(discoverTrack, 0, true);
    for (let second = 1; second <= 8; second += 1) skipLearning.update(discoverTrack, second, true);
    skipLearning.skip(discoverTrack, 180);

    expect(emitSkip).toHaveBeenCalledTimes(1);
    expect(emitSkip).toHaveBeenCalledWith(
      'music_play_skipped_early',
      expect.objectContaining({ source: 'discover', listened_sec: 8 }),
    );
  });

  it('records only an early generated skip as soft negative', () => {
    const emit = vi.fn();
    const learning = new ListeningLearning(emit, 30);
    learning.update(generated, 0, true);
    for (let second = 1; second <= 10; second += 1) learning.update(generated, second, true);
    learning.skip(generated, 180);
    learning.complete(generated, 180);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      'music_generated_skipped_early',
      expect.objectContaining({ source: 'auto_mode' }),
    );
  });
});
