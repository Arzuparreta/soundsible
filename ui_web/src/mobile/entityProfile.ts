import { createEffect, createSignal, on, onCleanup } from 'solid-js';
import { api } from '../lib/api';
import { albumPath, artistPath, decodeArtistName, parseViewParams } from '../lib/artistRoute';
import type { AlbumProfile, ArtistProfile } from '../types/music';
import type { SavedEntity } from '../lib/savedEntityIdentity';

export interface NativeEntitySubject {
  kind: 'artist' | 'album'; name: string; artist?: string;
  view: 'discover' | 'library'; deezerId?: string; localId?: string;
}
export function nativeEntitySubject(path: string): NativeEntitySubject | null {
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  const url = new URL(path, 'https://native.invalid');
  const match = /^\/(artist|album)\/([^/]+)$/.exec(url.pathname);
  if (!match) return null;
  const kind = match[1] as 'artist' | 'album', params = parseViewParams(Object.fromEntries(url.searchParams));
  return { kind, name: decodeArtistName(match[2]), artist: kind === 'album' ? url.searchParams.get('artist') ?? '' : undefined,
    view: params.view, deezerId: params.deezerId, localId: kind === 'artist' ? params.artistId : params.albumId };
}
export function nativeProfileBookmark(subject: NativeEntitySubject, profile?: ArtistProfile | AlbumProfile | null): SavedEntity {
  const deezerId = subject.deezerId ?? profile?.deezer_id ?? undefined;
  return { kind: subject.kind, name: subject.name, artist: subject.artist,
    cover: subject.kind === 'artist' ? (profile as ArtistProfile | undefined)?.metadata?.picture : (profile as AlbumProfile | undefined)?.cover,
    destination: subject.kind === 'artist'
      ? artistPath(subject.name, { view: subject.view, deezerId, artistId: subject.localId })
      : albumPath(subject.name, subject.artist ?? '', { view: subject.view, deezerId, albumId: subject.localId }) };
}

/** Profile responses are scoped to subject and engine identity, including retries. */
export function createNativeEntityProfile(props: {
  subject: () => NativeEntitySubject; generation: () => number; disconnected: () => boolean;
}, fetchProfile = (subject: NativeEntitySubject, signal: AbortSignal): Promise<ArtistProfile | AlbumProfile> => subject.kind === 'artist'
  ? api.getArtistProfile(subject.name, subject.deezerId, signal)
  : api.getAlbumProfile(subject.name, subject.artist ?? '', subject.deezerId, signal)) {
  const [profile, setProfile] = createSignal<ArtistProfile | AlbumProfile | null>(null);
  const [loading, setLoading] = createSignal(false), [error, setError] = createSignal(false), [retry, setRetry] = createSignal(0);
  let epoch = 0, disposed = false;
  createEffect(on(() => [JSON.stringify(props.subject()), props.generation(), props.disconnected(), retry()] as const,
    ([serialized, generation, disconnected], previous) => {
      const operation = ++epoch, controller = new AbortController();
      if (!previous || serialized !== previous[0] || generation !== previous[1]) setProfile(null);
      setError(false); setLoading(!disconnected);
      if (!disconnected) void fetchProfile(JSON.parse(serialized), controller.signal).then(next => {
        if (!disposed && epoch === operation && generation === props.generation() && !controller.signal.aborted && !props.disconnected()) setProfile(next);
      }).catch(() => { if (!disposed && epoch === operation && !controller.signal.aborted) setError(true); })
        .finally(() => { if (!disposed && epoch === operation) setLoading(false); });
      onCleanup(() => controller.abort());
    }));
  onCleanup(() => { disposed = true; epoch++; });
  return { profile, loading, error, retry: () => setRetry(value => value + 1) };
}
