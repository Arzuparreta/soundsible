import { toast } from './toast';
import { isPodcastTrack } from './track';
import { t } from './i18n';
import { playbackYoutubeId } from './media';

interface ShareableTrack {
  id: string;
  title: string;
  artist?: string;
  youtube_id?: string | null;
  source?: 'preview';
  media_kind?: string | null;
  podcast_episode_guid?: string | null;
}

/**
 * Resolve the shareable YouTube URL from the same video identity playback
 * uses. Podcast episodes have no YouTube identity (their id is an episode
 * guid), so they share as text only.
 */
export function shareUrlFor(track: ShareableTrack): string {
  if (isPodcastTrack(track)) return '';
  const videoId = playbackYoutubeId(track);
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : '';
}

/**
 * Share a track via the Web Share API, falling back to clipboard. Ports the
 * legacy `shared.js` share flow: a YouTube URL when the track has one, else the
 * "Title — Artist" text. A user-cancelled native share is a no-op (not an error).
 */
export async function shareTrack(track: ShareableTrack): Promise<void> {
  const url = shareUrlFor(track);
  const text = track.artist ? `${track.title} — ${track.artist}` : track.title;

  if (navigator.share) {
    try {
      const data: ShareData = { title: track.title, text };
      if (url) data.url = url;
      await navigator.share(data);
      return;
    } catch (e) {
      // AbortError = user dismissed the share sheet; anything else falls through.
      if (e instanceof Error && e.name === 'AbortError') return;
    }
  }

  const payload = url || text;
  try {
    await navigator.clipboard.writeText(payload);
    toast.success(t('social.copied'));
  } catch {
    toast.error(t('social.shareFailed'));
  }
}
