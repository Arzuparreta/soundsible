import { createMemo, createSignal, onCleanup } from 'solid-js';
import { api, ApiError } from '../lib/api';
import { catalogTrack, itemArtist } from '../lib/catalogTrack';
import { buildIdentityIndex, catalogItemKeys } from '../lib/playbackIdentity';
import { savedFromCatalogItem, savedFromTrack, savedToTrack } from '../lib/saved';
import { programTrack } from '../lib/program/tracks';
import { t } from '../lib/i18n';
import type { CatalogItem, SavedEntry, Track } from '../types/music';

export type CatalogPurpose = 'play' | 'save' | 'remove' | 'acquire';

/** Search, recommendations and entity songs share account-scoped native actions. */
export function createNativeCatalogActions(props: {
  generation: () => number; tracks: () => Track[]; saved: () => SavedEntry[];
  disconnected: () => boolean; onPlay: (track: Track) => Promise<void>;
  onAcquire?: (track: Track) => Promise<void>; onChanged: () => Promise<void>;
}) {
  const [pending, setPending] = createSignal<string | null>(null);
  const [error, setError] = createSignal('');
  const [resolvedTracks, setResolvedTracks] = createSignal(new Map<string, Track>());
  const libraryIndex = createMemo(() => buildIdentityIndex(props.tracks()));
  const savedKeys = createMemo(() => new Set(props.saved().flatMap(entry => entry.keys)));
  let epoch = 0;
  let controller: AbortController | undefined;
  let disposed = false;
  const trackFor = (item: CatalogItem): Track | null => {
    const immediate = catalogTrack(item, props.tracks());
    if (immediate) return immediate;
    for (const key of catalogItemKeys(item)) {
      const track = libraryIndex().get(key);
      if (track && programTrack(track)) return track;
    }
    return resolvedTracks().get(item.id) ?? null;
  };
  function reset(clearResolved = false) {
    epoch++; controller?.abort(); setPending(null); setError('');
    if (clearResolved) setResolvedTracks(new Map());
  }
  onCleanup(() => { disposed = true; reset(true); });
  async function act(item: CatalogItem, purpose: CatalogPurpose) {
    if (disposed || props.disconnected()) return;
    const operation = ++epoch, generation = props.generation();
    controller?.abort(); const request = new AbortController(); controller = request;
    const current = () => !disposed && epoch === operation && generation === props.generation() && !request.signal.aborted && !props.disconnected();
    setPending(item.id); setError('');
    try {
      let track = trackFor(item), entry = savedFromCatalogItem(item);
      if (purpose !== 'remove' && !track) {
        const artist = itemArtist(item);
        if (!artist || !item.title) throw new Error('Missing recording');
        const result = await api.resolveCatalogItem({ artist, title: item.title, duration: item.duration }, request.signal);
        if (!current()) return;
        if (!result.video_id || !/^[A-Za-z0-9_-]{11}$/.test(result.video_id)) throw new Error('No preview');
        entry = { ...entry, keys: [...new Set([...entry.keys, `yt:${result.video_id}`])] };
        track = savedToTrack(entry, libraryIndex());
        if (track) { const linked = new Map(resolvedTracks()); linked.set(item.id, track); setResolvedTracks(linked); }
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
  return { trackFor, pending, error, reset, act,
    isSaved: (item: CatalogItem) => catalogItemKeys(item).some(key => savedKeys().has(key)) };
}
