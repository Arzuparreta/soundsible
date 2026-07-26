import { toast } from './toast';
import { isPodcastTrack } from './track';
import { t } from './i18n';
import { shareUrlForTrack } from './trackShare';

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
 * Resolve the Soundsible bridge URL from the same video identity playback
 * uses. Podcast episodes keep their existing text-only sharing behaviour.
 */
export function shareUrlFor(track: ShareableTrack): string {
  if (isPodcastTrack(track)) return '';
  return shareUrlForTrack(track) || '';
}

/**
 * Share a track via the Web Share API, falling back to clipboard. Ports the
 * legacy `shared.js` share flow. Music gets a private-fragment Soundsible URL;
 * podcasts remain text-only. A dismissed native share is a no-op.
 */
export async function shareTrack(track: ShareableTrack): Promise<void> {
  const url = shareUrlFor(track);
  const text = track.artist ? `${track.title} — ${track.artist}` : track.title;
  if (!isPodcastTrack(track) && !url) {
    toast.error(t('social.shareIdentityMissing'));
    return;
  }

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
