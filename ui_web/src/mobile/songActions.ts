import type { MenuAction } from '../components/ActionMenu';
import type { Device } from '../lib/api';
import { openContextMenu } from '../lib/contextMenu';
import { request } from '../lib/http';
import { t } from '../lib/i18n';
import { musicLinks, type MusicMetadata } from '../lib/musicLinks';
import { toast } from '../lib/toast';
import { isPodcastTrack } from '../lib/track';
import type { CatalogItem, RecommendationContext, Track } from '../types/music';
import type { PodcastSearchResult } from '../types/podcast';

/** "Go to artist" per performer, then "Open album": the same entries and order as the web song menu. */
export function nativeMusicLinkActions(meta: MusicMetadata, open: (path: string) => void, disabled: boolean): MenuAction[] {
  return musicLinks(meta).map(link => link.kind === 'artist'
    ? { label: link.several ? `${t('trackActions.goToArtist')}: ${link.name}` : t('trackActions.goToArtist'), disabled, onSelect: () => open(link.path) }
    : { label: t('musicExplorer.openAlbum'), disabled, onSelect: () => open(link.path) });
}

/** What the engine needs to learn from "not interested" in a recommended song. */
export function catalogFeedback(item: CatalogItem): { recommendation: RecommendationContext; item: Record<string, unknown> } | null {
  const recommendation = item.raw?.recommendation as RecommendationContext | undefined;
  if (!recommendation?.identity) return null;
  const youtube = item.raw?.youtube_id ?? item.external_ids?.youtube_id;
  return { recommendation, item: {
    media_type: 'music_track', track_id: item.track_id, title: item.title, artist: item.artist,
    youtube_id: typeof youtube === 'string' ? youtube : undefined, source: recommendation.source,
  } };
}

/** The reason a recommendation was made, then "Not interested" with an undo, scoped to the account that sent it. */
/** A recommended show: "not interested" teaches the engine about the feed, not an episode. */
export function podcastFeedback(show: PodcastSearchResult): Feedback | null {
  if (!show.recommendation_identity) return null;
  return { recommendation: { reason: show.reason }, item: { media_type: 'podcast_show', podcast_feed_id: show.feed_url,
    podcast_show_title: show.title, podcast_author: show.author, itunes_collection_id: show.itunes_collection_id, source: 'podcast' } };
}

type Feedback = { recommendation: { reason?: string }; item: Record<string, unknown> };
export function nativeFeedbackActions(feedback: Feedback | null, current: () => boolean): MenuAction[] {
  if (!feedback) return [];
  return [
    ...(feedback.recommendation.reason ? [{ label: feedback.recommendation.reason, disabled: true, onSelect: () => {} }] : []),
    { label: t('trackActions.notInterested'), disabled: !current(), onSelect: () => {
      if (!current()) return;
      void request<{ recorded?: boolean; event_id?: string | null }>('/api/discovery/feedback', {
        method: 'POST', body: { feedback: 'not_interested', item: feedback.item }, timeoutMs: 5000,
      }).then(result => {
        if (!current() || !result.recorded || !result.event_id) return;
        const event = result.event_id;
        toast.action(t('trackActions.feedbackSaved'), t('common.undo'), () => {
          if (current()) void request(`/api/discovery/feedback/${encodeURIComponent(event)}`, { method: 'DELETE', timeoutMs: 5000 }).catch(() => {});
        });
      }).catch(() => { if (current()) toast.error(t('trackActions.feedbackFailed')); });
    } },
  ];
}

/** Only songs the server has can be started elsewhere; a DJ set is not handed over song by song. */
export const canPlayOnDevice = (track: Track) => (track.source ?? 'local') === 'local' && !isPodcastTrack(track);

/** Lists the account's other online devices and asks the chosen one to play this library song. */
export async function openNativePlayOnDevice(track: Track, self: () => Promise<string | null>, current: () => boolean, event?: MouseEvent): Promise<void> {
  if (!current() || !canPlayOnDevice(track)) return;
  let devices: Device[];
  try {
    const [listed, own] = await Promise.all([request<{ devices?: Device[] }>('/api/devices', { timeoutMs: 8000 }), self()]);
    devices = (listed.devices ?? []).filter(device => device.device_id !== own && device.socket_active);
  } catch { if (current()) toast.error(t('deviceSheet.failed')); return; }
  if (!current()) return;
  if (!devices.length) { toast.info(t('deviceSheet.emptyOthers')); return; }
  openContextMenu({ title: t('deviceSheet.title'), subtitle: track.title, actions: devices.map(device => ({
    label: device.device_name ?? device.device_id,
    onSelect: () => {
      if (!current()) return;
      const name = device.device_name ?? t('deviceSheet.fallbackDevice');
      const progress = toast.loading(t('deviceSheet.sendingTo', { device: name }));
      void request('/api/playback/remote-command', { method: 'POST', body: { device_id: device.device_id, command: 'play', track_id: track.id }, timeoutMs: 8000 })
        .then(() => { if (current()) progress.update('success', t('deviceSheet.playingOn')); else progress.dismiss(); })
        .catch(() => { if (current()) progress.update('error', t('deviceSheet.failed')); else progress.dismiss(); });
    },
  })) }, event);
}
