import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PodcastProgress } from './podcastProgress';
import type { Track } from '../types/music';

const track: Track = { id: 'a', title: 'Episode', artist: 'Show', media_kind: 'podcast_episode', podcast_enclosure_url: 'https://example.com/a.mp3' };
beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe('durable episode progress', () => {
  it('survives a new page and keeps episodes and accounts independent', () => {
    const progress = new PodcastProgress();
    progress.save(track, 'alice', 70, 200);
    progress.save({ ...track, podcast_enclosure_url: 'https://example.com/b.mp3' }, 'alice', 20, 200);
    const reloaded = new PodcastProgress();
    expect(reloaded.position({ ...track, id: 'downloaded-a', source: undefined }, 'alice')).toBe(70);
    expect(reloaded.position(track, 'bob')).toBe(0);
    expect(reloaded.position(track, 'alice')).toBe(70);
  });

  it('replays completed episodes from the start and remembers deliberate backward seeks', () => {
    const progress = new PodcastProgress();
    progress.save(track, 'alice', 200, 200, true);
    expect(new PodcastProgress().position(track, 'alice')).toBe(0);
    progress.save(track, 'alice', 150, 200);
    expect(new PodcastProgress().position(track, 'alice')).toBe(150);
  });

  it('ignores malformed storage and invalid positions without preventing playback', () => {
    localStorage.setItem('podcast-progress:alice', '{broken');
    const progress = new PodcastProgress();
    expect(progress.position(track, 'alice')).toBe(0);
    progress.save(track, 'alice', NaN, 200);
    expect(progress.position(track, 'alice')).toBe(0);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    progress.save(track, 'alice', 40, 200);
    expect(progress.position(track, 'alice')).toBe(40);
  });
});
