import { toast } from './toast';
import { isPodcastTrack } from './track';
import { t } from './i18n';
import { shareUrlForTrack } from './trackShare';
import { copyText } from './clipboard';
import { openCopyLinkDialog } from './copyLink';

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
 * Share a track: the native share sheet where the browser offers one, a
 * clipboard copy otherwise, and — if even that is refused — a dialog holding
 * the link so it can be copied by hand. Every step degrades into the next, so
 * the only silent outcome is the user dismissing the share sheet themselves.
 *
 * Music gets a private-fragment Soundsible URL. Podcast episodes, and the odd
 * track with no video identity behind it, have no link to give: they share
 * their title and artist as text rather than refusing.
 */
export async function shareTrack(track: ShareableTrack): Promise<void> {
  const url = shareUrlFor(track);
  const text = track.artist ? `${track.title} — ${track.artist}` : track.title;
  const payload = url || text;

  if (navigator.share) {
    try {
      const data: ShareData = { title: track.title, text };
      if (url) data.url = url;
      await navigator.share(data);
      return;
    } catch (e) {
      // AbortError = user dismissed the share sheet, and that is the answer.
      // Anything else (no permission, no target app, stale user activation)
      // falls through to copying. The name is read off the value itself: a
      // DOMException does not inherit from Error everywhere.
      if ((e as { name?: string } | null)?.name === 'AbortError') return;
    }
  }

  if (await copyText(payload)) {
    toast.success(url ? t('social.copied') : t('social.copiedTextOnly'));
    return;
  }

  openCopyLinkDialog({
    title: url ? t('social.copyManualTitle') : t('social.copyManualTitleText'),
    message: t('social.copyManualHint'),
    value: payload,
  });
}
