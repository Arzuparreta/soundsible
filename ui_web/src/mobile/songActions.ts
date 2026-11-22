import type { MenuEvent } from '../lib/menuEvent';
import type { MenuAction } from '../components/ActionMenu';
import { api, type Device } from '../lib/api';
import { itemArtist } from '../lib/catalogTrack';
import { openContextMenu } from '../lib/contextMenu';
import { request } from '../lib/http';
import { t } from '../lib/i18n';
import { musicLinks, type MusicMetadata } from '../lib/musicLinks';
import { toast } from '../lib/toast';
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
  const deezerRaw = item.external_ids?.deezer_id ?? item.raw?.deezer_id;
  const deezerId = typeof deezerRaw === 'string' && deezerRaw
    ? deezerRaw
    : typeof deezerRaw === 'number'
      ? String(deezerRaw)
      : undefined;
  const deezerArtistRaw = item.external_ids?.deezer_artist_id ?? item.raw?.deezer_artist_id;
  const deezerArtistId = typeof deezerArtistRaw === 'string' && deezerArtistRaw
    ? deezerArtistRaw
    : typeof deezerArtistRaw === 'number'
      ? String(deezerArtistRaw)
      : undefined;
  const isrcRaw = item.external_ids?.isrc ?? item.raw?.isrc;
  const isrc = typeof isrcRaw === 'string' && isrcRaw ? isrcRaw : undefined;
  const mbidRaw = item.external_ids?.mbid ?? item.external_ids?.musicbrainz_id ?? item.raw?.mbid;
  const mbid = typeof mbidRaw === 'string' && mbidRaw ? mbidRaw : undefined;
  const primaryArtist = item.raw?.artists?.map((name) => name.trim()).find(Boolean) || itemArtist(item);
  return { recommendation, item: {
    media_type: 'music_track', track_id: item.track_id, title: item.title, artist: primaryArtist,
    youtube_id: typeof youtube === 'string' ? youtube : undefined,
    ...(deezerId ? { deezer_id: deezerId } : {}),
    ...(deezerArtistId ? { deezer_artist_id: deezerArtistId } : {}),
    ...(isrc ? { isrc } : {}),
    ...(mbid ? { mbid } : {}),
    source: recommendation.source,
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
export function nativeFeedbackActions(
  feedback: Feedback | null,
  current: () => boolean,
  hooks?: {
    onDismissed?: () => void;
    onUndone?: () => void;
    onArtistDismissed?: (artist: string) => void;
    onArtistUndone?: (artist: string) => void;
  },
): MenuAction[] {
  if (!feedback) return [];
  const send = (
    kind: 'not_interested' | 'less_from_artist',
    onDismissed?: () => void,
    onUndone?: () => void,
  ) => {
    if (!current()) return;
    void request<{ recorded?: boolean; event_id?: string | null }>('/api/discovery/feedback', {
      method: 'POST', body: { feedback: kind, item: feedback.item }, timeoutMs: 5000,
    }).then(result => {
      if (!current() || !result.recorded || !result.event_id) return;
      onDismissed?.();
      const event = result.event_id;
      toast.action(t('trackActions.feedbackSaved'), t('common.undo'), () => {
        if (current()) {
          void request(`/api/discovery/feedback/${encodeURIComponent(event)}`, { method: 'DELETE', timeoutMs: 5000 })
            .then(() => { if (current()) onUndone?.(); })
            .catch(() => {});
        }
      });
    }).catch(() => { if (current()) toast.error(t('trackActions.feedbackFailed')); });
  };
  const isPodcast = String(feedback.item.media_type ?? '').startsWith('podcast');
  const artist = !isPodcast && typeof feedback.item.artist === 'string'
    ? feedback.item.artist.trim()
    : '';
  return [
    ...(feedback.recommendation.reason ? [{ label: feedback.recommendation.reason, disabled: true, onSelect: () => {} }] : []),
    { label: t('trackActions.notInterested'), disabled: !current(), onSelect: () => send('not_interested', hooks?.onDismissed, hooks?.onUndone) },
    ...(artist ? [{
      label: t('trackActions.lessFromArtist'),
      disabled: !current(),
      onSelect: () => send('less_from_artist', () => hooks?.onArtistDismissed?.(artist), () => hooks?.onArtistUndone?.(artist)),
    }] : []),
  ];
}

export { canPlayOnDevice } from '../lib/remotePlayback';
import { canPlayOnDevice, remoteCommandMessage, remotePlayTracksArgs } from '../lib/remotePlayback';

/** Lists the account's other online devices and asks the chosen one to play this element. */
export async function openNativePlayOnDevice(track: Track, self: () => Promise<string | null>, current: () => boolean, event?: MenuEvent): Promise<void> {
  if (!current() || !canPlayOnDevice(track)) return;
  let devices: Device[];
  try {
    const [listed, own] = await Promise.all([request<{ devices?: Device[] }>('/api/devices', { timeoutMs: 8000 }), self()]);
    devices = (listed.devices ?? []).filter(device => device.device_id !== own && Boolean(device.online ?? device.socket_active));
  } catch { if (current()) toast.error(t('common.loadFailed')); return; }
  if (!current()) return;
  if (!devices.length) { toast.info(t('deviceSheet.emptyOthers')); return; }
  openContextMenu({ title: t('deviceSheet.title'), subtitle: track.title, actions: devices.map(device => ({
    label: device.device_name ?? device.device_id,
    onSelect: () => {
      if (!current()) return;
      const name = device.device_name ?? t('deviceSheet.fallbackDevice');
      const progress = toast.loading(t('deviceSheet.sendingTo', { device: name }));
      void api.deviceCommand(device.device_id, 'play.tracks', remotePlayTracksArgs(track), { timeoutMs: 10_000 })
        .then(answer => {
          if (!current()) { progress.dismiss(); return; }
          if (answer.status === 'applied') progress.update('success', t('deviceSheet.playingOn'));
          else progress.update('error', remoteCommandMessage(answer, name));
        })
        .catch(() => { if (current()) progress.update('error', remoteCommandMessage(null, name)); else progress.dismiss(); });
    },
  })) }, event);
}
