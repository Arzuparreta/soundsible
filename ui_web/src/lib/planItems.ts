import type { DjItemRef, ListeningPlanItem } from './api';
import type { AutoPlanItem } from './generatedQueue';
import { t as tr } from './i18n';
import type { Track } from '../types/music';

/** A planned item as the track the queue plays: the library's own copy when the
 * listener owns it, a preview otherwise, with the plan's provenance attached. */
export function planItemTrack(item: ListeningPlanItem, library: readonly Track[]): Track {
  const local = item.track_id ? library.find(track => track.id === item.track_id) : null;
  const base: Track = local ? { ...local } : {
    id: item.youtube_id || item.id,
    title: item.title,
    artist: item.artist,
    album: item.album,
    duration: item.duration,
    cover: item.cover,
    source: 'preview',
  };
  return {
    ...base,
    item_id: item.item_id ?? base.item_id,
    artist_is_channel: local ? false : item.artist_is_channel,
    artists: local?.artists ?? item.artists ?? undefined,
    deezer_artist_id: base.deezer_artist_id ?? item.deezer_artist_id ?? undefined,
    deezer_album_id: base.deezer_album_id ?? item.deezer_album_id ?? undefined,
    source_title: item.source_title,
    source_artist: item.source_artist,
    youtube_id: item.youtube_id ?? base.youtube_id,
    discovery_youtube_id: item.discovery_youtube_id,
    playback_source_kind: item.playback_source_kind,
    canonical_identity: item.canonical_identity,
    recommendation: {
      identity: item.recommendation_identity,
      source: item.recommendation_source,
      reason: item.recommendation_source === 'autoplay' ? tr('autoplay.reason') : item.reason,
      reason_code: item.reason_code,
      discovery_youtube_id: item.discovery_youtube_id ?? undefined,
    },
  };
}

/** The reference the DJ endpoints take for a song. */
export function djItemRef(track: Track): DjItemRef {
  return {
    item_id: track.item_id,
    id: track.id,
    track_id: track.source === 'preview' ? undefined : track.id,
    youtube_id: track.youtube_id ?? (track.source === 'preview' ? track.id : undefined),
    source: track.source,
    title: track.title,
    artist: track.artist,
    artist_is_channel: track.artist_is_channel,
    duration: track.duration,
  };
}

/** The seed body the generic planner takes. */
export function planSeed(seed: Track) {
  return {
    id: seed.id,
    track_id: seed.source === 'preview' ? undefined : seed.id,
    youtube_id: seed.youtube_id ?? (seed.source === 'preview' ? seed.id : undefined),
    discovery_youtube_id: seed.discovery_youtube_id ?? undefined,
    source: seed.source,
    title: seed.title,
    artist: seed.artist,
    album: seed.album,
    duration: seed.duration,
  };
}

export function autoReasonKey(item: ListeningPlanItem): string {
  if (item.source_pool === 'related') return 'autoMode.reason.related';
  if (item.source_pool === 'local') return 'autoMode.reason.library';
  return 'autoMode.reason.node';
}

/** The route's record of why `item` is there and which song its cue leaves. */
export function routePlanEntry(item: ListeningPlanItem, trackId: string, fromKey: string, transition = item.transition): AutoPlanItem {
  return {
    trackId,
    source: item.source_pool,
    reasonKey: autoReasonKey(item),
    fromKey,
    transition,
    bpm: item.analysis?.bpm,
    key: item.analysis?.key,
    sourceSetId: item.source_set_id,
    sourceSetLabel: item.source_set_label,
    lineage: item.lineage,
  };
}
