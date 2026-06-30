import { describe, it, expect } from 'vitest';
import { isPodcastTrack, isMusicTrack, podcastEpisodeToTrack } from './track';
import type { Track } from '../types/music';
import type { PodcastEpisode } from '../types/podcast';

const music: Track = { id: 'm1', title: 'Song', artist: 'A' };

describe('isPodcastTrack / isMusicTrack', () => {
  it('flags downloaded episodes by media_kind', () => {
    const dl: Track = { ...music, media_kind: 'podcast_episode' };
    expect(isPodcastTrack(dl)).toBe(true);
    expect(isMusicTrack(dl)).toBe(false);
  });

  it('flags streamed episodes by podcast_episode_guid', () => {
    const stream: Track = { ...music, source: 'preview', podcast_episode_guid: 'guid-1' };
    expect(isPodcastTrack(stream)).toBe(true);
    expect(isMusicTrack(stream)).toBe(false);
  });

  it('treats plain music tracks (and preview music) as music', () => {
    const previewMusic: Track = { ...music, source: 'preview' };
    expect(isMusicTrack(music)).toBe(true);
    expect(isMusicTrack(previewMusic)).toBe(true);
    expect(isPodcastTrack(music)).toBe(false);
  });
});

describe('podcastEpisodeToTrack', () => {
  const ep: PodcastEpisode = {
    guid: 'ep-guid',
    title: 'Episode 1',
    enclosure_url: 'https://cdn.example/ep1.mp3',
    duration_sec: 1800,
    image: 'https://cdn.example/cover.jpg',
  };

  it('tags the track as a podcast so it stays out of music flows', () => {
    const t = podcastEpisodeToTrack(ep, 'My Show');
    expect(t.media_kind).toBe('podcast_episode');
    expect(t.podcast_episode_guid).toBe('ep-guid');
    expect(t.source).toBe('preview');
    expect(isPodcastTrack(t)).toBe(true);
    expect(t.artist).toBe('My Show');
    expect(t.id).toBe('ep-guid');
  });

  it('falls back to the enclosure url when the episode has no guid', () => {
    const noGuid: PodcastEpisode = { ...ep, guid: '' };
    const t = podcastEpisodeToTrack(noGuid);
    expect(t.id).toBe(noGuid.enclosure_url);
    expect(t.podcast_episode_guid).toBe(noGuid.enclosure_url);
    expect(isPodcastTrack(t)).toBe(true);
  });
});
