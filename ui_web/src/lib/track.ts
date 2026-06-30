import type { Track } from '../types/music';
import type { PodcastEpisode } from '../types/podcast';

/**
 * A track is a podcast episode when it carries podcast provenance — either the
 * library `media_kind` marker (set on downloaded episodes) or an episode guid
 * (set on streamed episodes). The music-library surfaces, radio, and the
 * generic playback queue all key off this to keep podcasts out of music flows.
 */
export function isPodcastTrack(track: Pick<Track, 'media_kind' | 'podcast_episode_guid'>): boolean {
  return track.media_kind === 'podcast_episode' || !!track.podcast_episode_guid;
}

/** Inverse of {@link isPodcastTrack}: the track belongs in the music library. */
export function isMusicTrack(track: Pick<Track, 'media_kind' | 'podcast_episode_guid'>): boolean {
  return !isPodcastTrack(track);
}

/**
 * Build a playable preview Track from a podcast episode, tagged as a podcast so
 * the rest of the app treats it correctly: no "save to library", no radio, and
 * no music-queue operations (its stream is a minted token, not a `previewUrl`,
 * so the generic queue cannot re-load it). The id mirrors the episode key used
 * by {@link PodcastShow} so the "now playing" highlight lines up.
 */
export function podcastEpisodeToTrack(ep: PodcastEpisode, showTitle?: string): Track {
  const key = ep.guid || ep.enclosure_url;
  return {
    id: key,
    title: ep.title,
    artist: showTitle ?? '',
    duration: ep.duration_sec,
    cover: ep.image,
    source: 'preview',
    media_kind: 'podcast_episode',
    podcast_episode_guid: key,
  };
}
