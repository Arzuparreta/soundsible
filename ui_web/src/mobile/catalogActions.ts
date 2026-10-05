import { createMemo, createSignal, onCleanup } from 'solid-js';
import { api, ApiError } from '../lib/api';
import { catalogTrack, itemArtist } from '../lib/catalogTrack';
import { buildIdentityIndex, catalogItemKeys, trackKeys } from '../lib/playbackIdentity';
import { savedFromCatalogItem, savedFromTrack, savedToTrack } from '../lib/saved';
import { programTrack } from '../lib/program/tracks';
import { resolveNativeCatalogProgram } from './catalogProgram';
import { t } from '../lib/i18n';
import type { CatalogItem, SavedEntry, Track } from '../types/music';
import type { MigrationJob } from '../lib/migrationApi';

export type CatalogPurpose = 'play' | 'save' | 'remove' | 'acquire';

/** Search, recommendations and entity songs share account-scoped native actions. */
export function createNativeCatalogActions(props: {
  generation: () => number; tracks: () => Track[]; saved: () => SavedEntry[];
  disconnected: () => boolean; onPlay: (track: Track) => Promise<void>;
  onAcquire?: (track: Track) => Promise<void>; onChanged: () => Promise<void>;
  onPlayCollection?: (tracks: Track[], index: number, context?: import('../lib/program/runtime').ProgramContext, shuffle?: boolean) => Promise<void>;
}) {
  const [pending, setPending] = createSignal<string | null>(null);
  const [error, setError] = createSignal('');
  const [partial, setPartial] = createSignal(false);
  const [resolvedTracks, setResolvedTracks] = createSignal(new Map<string, Track>());
  const [collectionLinks, setCollectionLinks] = createSignal(new Map<string, Map<string, string>>());
  const libraryIndex = createMemo(() => buildIdentityIndex(props.tracks()));
  const collectionIndex = createMemo(() => {
    const index = new Map<string, Track>();
    for (const links of collectionLinks().values()) for (const [key, id] of links) {
      const track = libraryIndex().get(`lib:${id}`);
      if (track && track.source !== 'preview' && programTrack(track)) index.set(key, track);
    }
    return index;
  });
  const savedKeys = createMemo(() => new Set(props.saved().flatMap(entry => entry.keys)));
  const savedIndex = createMemo(() => {
    const index = new Map<string, Track>();
    for (const entry of props.saved()) {
      const track = savedToTrack(entry, libraryIndex());
      if (track && programTrack(track)) for (const key of entry.keys) if (!index.has(key)) index.set(key, track);
    }
    return index;
  });
  let epoch = 0;
  let controller: AbortController | undefined;
  let disposed = false;
  const trackFor = (item: CatalogItem): Track | null => {
    const immediate = catalogTrack(item, props.tracks());
    if (immediate && immediate.source !== 'preview') return immediate;
    for (const key of catalogItemKeys(item)) {
      const track = libraryIndex().get(key);
      if (track && programTrack(track)) return track;
    }
    for (const key of catalogItemKeys(item)) {
      const held = savedIndex().get(key);
      if (held) return held;
    }
    for (const key of catalogItemKeys(item)) {
      const held = collectionIndex().get(key);
      if (held) return held;
    }
    const resolved = resolvedTracks().get(item.id);
    if (resolved) for (const key of trackKeys(resolved)) {
      const owned = libraryIndex().get(key);
      if (owned && owned.source !== 'preview' && programTrack(owned)) return owned;
    }
    return resolved ?? immediate;
  };
  function reset(clearResolved = false) {
    epoch++; controller?.abort(); setPending(null); setError(''); setPartial(false);
    if (clearResolved) { setResolvedTracks(new Map()); setCollectionLinks(new Map()); }
  }
  /** Confirmed Core rows link catalog identities to owned files without saving songs. */
  function adoptCollection(job: MigrationJob, generation: number) {
    if (disposed || props.generation() !== generation || !/^(album|artist):\d{1,20}$/.test(job.provider)) return;
    const links = new Map<string, string>();
    for (const row of job.tracks ?? []) {
      if (!['completed', 'existing'].includes(row.state) || !row.matched_track_id || !Array.isArray(row.source?.identity_keys)) continue;
      for (const key of row.source.identity_keys) if (typeof key === 'string' && key.length <= 256) links.set(key, row.matched_track_id);
    }
    const next = new Map(collectionLinks()); next.set(job.provider, links); setCollectionLinks(next);
  }
  onCleanup(() => { disposed = true; reset(true); });
  async function resolveRecording(item: CatalogItem, signal: AbortSignal, current: () => boolean) {
    const artist = itemArtist(item);
    if (!artist || !item.title) throw new Error('Missing recording');
    const result = await api.resolveCatalogItem({ artist, title: item.title, duration: item.duration }, signal);
    if (!current()) throw new DOMException('Obsolete recording', 'AbortError');
    if (!result.video_id || !/^[A-Za-z0-9_-]{11}$/.test(result.video_id)) throw new Error('No preview');
    const original = savedFromCatalogItem(item);
    const entry = { ...original, keys: [...new Set([...original.keys, `yt:${result.video_id}`])] };
    const track = savedToTrack(entry, libraryIndex());
    if (track) { const linked = new Map(resolvedTracks()); linked.set(item.id, track); setResolvedTracks(linked); }
    return { entry, track };
  }
  async function act(item: CatalogItem, purpose: CatalogPurpose) {
    if (disposed || props.disconnected()) return;
    const operation = ++epoch, generation = props.generation();
    controller?.abort(); const request = new AbortController(); controller = request;
    const current = () => !disposed && epoch === operation && generation === props.generation() && !request.signal.aborted && !props.disconnected();
    setPending(item.id); setError(''); setPartial(false);
    try {
      let track = trackFor(item), entry = savedFromCatalogItem(item);
      if (purpose !== 'remove' && !track) {
        const resolved = await resolveRecording(item, request.signal, current);
        entry = resolved.entry; track = resolved.track;

      }
      if (!current()) return;
      if (purpose !== 'remove' && track && !programTrack(track)) throw new Error('Unsupported recording');
      if (purpose === 'play') {
        if (!track) throw new Error('No preview');
        await props.onPlay(track);
      } else if (purpose === 'acquire') {
        if (!track || !props.onAcquire) throw new Error('Acquisition unavailable');
        await props.onAcquire(track);
      } else {
        if (purpose === 'save' && track) entry = { ...entry, keys: [...new Set([...entry.keys, ...savedFromTrack(track).keys])] };
        await api.setSavedEntries([entry], purpose === 'save');
        // Once submitted, the mutation belongs to its account even after navigation.
        if (!disposed && generation === props.generation()) await props.onChanged();
      }
    } catch (failure) {
      if (current()) setError(t(failure instanceof ApiError && failure.status === 403 ? 'android.permissionDenied' : purpose === 'play' ? 'search.noPreview' : 'common.loadFailed'));
    } finally { if (current()) setPending(null); }
  }
  async function playCollection(items: readonly CatalogItem[], selectedIndex: number, context?: import('../lib/program/runtime').ProgramContext, shuffle = false) {
    if (disposed || props.disconnected()) return;
    const operation = ++epoch, generation = props.generation();
    controller?.abort(); const request = new AbortController(); controller = request;
    const current = () => !disposed && operation === epoch && generation === props.generation() && !request.signal.aborted && !props.disconnected();
    setPending(items[selectedIndex]?.id ?? null); setError(''); setPartial(false);
    try {
      if (!props.onPlayCollection) throw new Error('Collection playback unavailable');
      const program = await resolveNativeCatalogProgram(items, selectedIndex, async item =>
        trackFor(item) ?? (await resolveRecording(item, request.signal, current)).track, current);
      if (!current()) return;
      setPartial(program.unavailable > 0);
      if (context || shuffle) await props.onPlayCollection(program.tracks, program.index, context, shuffle);
      else await props.onPlayCollection(program.tracks, program.index);
    } catch (failure) {
      if (current()) setError(t(failure instanceof ApiError && failure.status === 403 ? 'android.permissionDenied' : 'search.noPreview'));
    } finally { if (current()) setPending(null); }
  }
  return { trackFor, pending, error, partial, reset, act, playCollection, adoptCollection,
    isSaved: (item: CatalogItem) => catalogItemKeys(item).some(key => savedKeys().has(key)) };
}
